import { join } from "node:path"
import * as Effect from "effect/Effect"
import { implementPlanFlow } from "@llm4ts/flow/Flow"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { parseIssueRef } from "@llm4ts/flow/GitHubTool"
import { stage } from "@llm4ts/flow/PlanExecution"
import { assessThenPlan } from "@llm4ts/flow/Planner"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { summarisePr } from "@llm4ts/flow/PrSummary"
import { allReviewers } from "@llm4ts/flow/Review"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"
import { coderFromEnv } from "@llm4ts/runner/Connectors"
import { runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { resolveExampleInput, runExampleMain } from "./support.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveExampleInput()
  const issueRef = parseIssueRef(input.prompt)
  if (issueRef === undefined) {
    return yield* ScriptUsage.make({
      message: 'usage: pnpm --filter @llm4ts/examples issue-pr -- "owner/repo#number"'
    })
  }
  const store = makePlanStore(nodePlainFileStore)
  const planPath = join(input.workDir, `.llm4ts/issue-${issueRef.number}.md`)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: coderFromEnv(process.env),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const startBranch = yield* context.git.currentBranch
        const issue = yield* stage(
          context.events,
          `read issue ${issueRef.shortRef}`,
          context.hosting.readIssue(issueRef)
        )
        const payload = [
          `Issue: ${issue.title}`,
          "",
          `Reporter: ${issue.author}`,
          "",
          issue.body
        ].join("\n")
        const stored = yield* store.load(planPath)
        const plan =
          stored ??
          (yield* assessThenPlan(context.reasoning, payload).pipe(
            Effect.flatMap((verdict) =>
              verdict.kind === "Blocked"
                ? stage(
                    context.events,
                    "post assessment on issue",
                    context.hosting.writeIssueComment(issueRef, verdict.reason)
                  ).pipe(Effect.as(undefined))
                : store.save(planPath, verdict.value).pipe(Effect.as(verdict.value))
            )
          ))
        if (plan === undefined) {
          return
        }

        const completed = yield* implementPlanFlow(context, {
          store,
          planPath,
          plan: Effect.succeed(plan),
          system: "Implement one issue task at a time in the current repository.",
          reviewers: allReviewers
        })
        yield* stage(context.events, "push branch", context.git.push("origin", completed.epicId))
        const base = yield* context.git.defaultBase
        const diff = yield* context.git.diffVsBase(base)
        if (diff.trim().length === 0) {
          return yield* FlowAborted.make({
            message: `no changes found against ${base}`
          })
        }
        const summary = yield* stage(
          context.events,
          "summarise pull request",
          summarisePr(
            context.reasoning,
            diff,
            `Originating issue: ${issueRef.shortRef}\nTitle: ${issue.title}`
          )
        )
        yield* stage(
          context.events,
          "open pull request",
          context.hosting.createPr(
            summary.title,
            `${summary.body}\n\nCloses ${issueRef.shortRef}.`,
            base
          )
        )
        yield* store.remove(planPath)
        yield* stage(context.events, `return to ${startBranch}`, context.git.checkout(startBranch))
      })
  )
})

runExampleMain(program)
