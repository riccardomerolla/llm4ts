// Legacy modernization phase 3: implement the seeded plan behind the pack's gates.
//
// Runs rooted at the TARGET repository (`--repo <target>`), from the specs
// alone. The clean-room wall is ENFORCED, not advised: the flow refuses to
// start when anything matching the pack's legacy `sources:` regex sits in the
// target workspace, so the coder provably never reads legacy source.
//
// Per plan task: a shared chat implements it, the pack's reviewer lenses plus
// the minimal roster review the diff behind a gate (build for the first,
// tests-encoding task; test for the rest), and the task is committed. The
// first task must leave the acceptance tests RED — tests that pass before any
// implementation encode nothing, so the flow aborts. Pattern cards cited by
// the seeded specs are injected into the coder's brief as an advisory
// translation playbook (the specs still win).
//
// After the loop the verify gate must be green, then a spec-compliance judge
// scores the whole branch against the committed specs and feeds sub-bar
// reasoning back to the coder, bounded by LLM4TS_JUDGE_ROUNDS (default 2).
//
// Run: modernize-implement --repo ~/services/meridian-transfers
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Dimension, Sample } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import { makeChat } from "@llm4ts/flow/Chat"
import { FlowAborted, FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { loadPack } from "@llm4ts/flow/Pack"
import { loadPatternCards, taggedPatternIds } from "@llm4ts/flow/Patterns"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { implementTaskLoop, stage } from "@llm4ts/flow/PlanExecution"
import {
  lintCommand,
  minimalReviewers,
  reviewAndFixLoop,
  type ReviewIssue,
  type ReviewResult
} from "@llm4ts/flow/Review"
import { checkWall, wallBreachMessage } from "@llm4ts/flow/Wall"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const ModDir = "docs/modernization"

const judgeRounds = (): number => {
  const raw = Number.parseInt(process.env.LLM4TS_JUDGE_ROUNDS ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 2
}

const complianceDimensions = [
  Dimension.make({
    name: "spec-compliance",
    rubric:
      "Does the implementation satisfy every rule in the committed specs — exact values, " +
      "validation order, error paths — without weakening, deleting, or loosening any test or scenario?"
  }),
  Dimension.make({
    name: "scenario-coverage",
    rubric:
      "Is every BDD scenario in the seeded feature files exercised by an acceptance test in this diff?"
  })
]

/** Concatenates the committed specs — the judge's contract text. */
const gatherSpecs = Effect.fn("modernize-implement.gatherSpecs")(function* (
  target: WorkspaceShape,
  specsDir: string
) {
  const paths = yield* target.discover(`${specsDir}/**`).pipe(Effect.orElseSucceed(() => []))
  const parts: Array<string> = []
  for (const path of [...paths].sort()) {
    const text = yield* target.read(path).pipe(Effect.orElseSucceed(() => ""))
    if (text.trim().length > 0) {
      parts.push(`===== ${path} =====\n${text}`)
    }
  }
  return parts.join("\n\n")
})

const issueText = (issues: ReadonlyArray<ReviewIssue>): string =>
  issues.map((issue) => `${issue.title}\n${issue.description}`.trim()).join("\n\n")

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Implement the seeded modernization plan")
  const packDir = process.env.LLM4TS_PACK ?? "packs/cobol-springboot"
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const planPath = join(input.workDir, ModDir, "plan.md")

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      reviewers: [asReadOnly(coder)],
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const launchWorkspace = yield* makeNodeWorkspace(input.workspace)
        const target = yield* makeNodeWorkspace(input.workDir)
        const pack = yield* stage(context.events, "pack", loadPack(launchWorkspace, packDir))

        yield* stage(
          context.events,
          "wall",
          Effect.gen(function* () {
            if (pack.sources === undefined) {
              return yield* context.events.publish(
                Info.make({ message: "pack has no sources regex — wall check skipped" })
              )
            }
            const result = yield* checkWall(target, pack.sources)
            if (result._tag === "Breached") {
              return yield* FlowAborted.make({
                message: wallBreachMessage(
                  result,
                  "The implementation must be driven by the specs alone; remove the files and rerun."
                )
              })
            }
            yield* context.events.publish(
              Info.make({ message: "clean-room wall: no legacy source in the target workspace" })
            )
          })
        )

        const store = makePlanStore(files)
        const plan = yield* store.load(planPath)
        if (plan === undefined) {
          return yield* FlowAborted.make({
            message: `no plan at ${planPath} — run modernize-seed first`
          })
        }

        const gate = (name: string): Effect.Effect<ReviewResult, FlowError> | undefined => {
          const command = pack.gate(name)
          return command === undefined
            ? undefined
            : lintCommand(nodeProcessExecutor, context.events, command, input.workDir)
        }
        const buildGate = gate("build")
        const testGate = gate("test")
        const verifyGate = gate("verify") ?? testGate

        yield* stage(
          context.events,
          "branch",
          context.git.checkoutOrCreate(plan.epicId).pipe(Effect.asVoid)
        )

        // Pattern selection is deterministic: extraction tagged each program's
        // fragment with the cards its SOURCE matched, the specs carry those
        // ids, and only the cited cards reach the brief.
        const specText = yield* gatherSpecs(target, pack.specsDir)
        const cards = [
          ...(yield* loadPatternCards(launchWorkspace, `${packDir}/patterns`)),
          ...(yield* loadPatternCards(launchWorkspace, "patterns"))
        ]
        const cited = new Set(taggedPatternIds(specText))
        const playbook = cards.filter((card) => cited.has(card.id))
        const system = [
          pack.prompt("implement"),
          pack.lessons === undefined
            ? undefined
            : `Lessons from previous modernization runs — apply them:\n${pack.lessons}`,
          playbook.length === 0
            ? undefined
            : "Pattern cards cited by the specs — the translation playbook (advisory, the specs win):\n\n" +
              playbook.map((card) => `### ${card.id}\n${card.body}`).join("\n\n")
        ]
          .filter((part) => part !== undefined)
          .join("\n\n")
        if (playbook.length > 0) {
          yield* context.events.publish(
            Info.make({ message: `${playbook.length} pattern card(s) cited by the specs` })
          )
        }

        const coderChat = yield* makeChat(context.coder, { system })
        const firstTitle = plan.tasks[0]?.title

        yield* implementTaskLoop(store, context.events, planPath, plan, (task) =>
          Effect.gen(function* () {
            const testsTask = task.title === firstTitle
            yield* coderChat.ask(plan.taskPrompt(task))
            yield* reviewAndFixLoop({
              reviewers: [...minimalReviewers, ...pack.lenses],
              reviewerService: context.reviewers[0] ?? context.reasoning,
              coder: coderChat,
              taskTitle: task.title,
              currentDiff: context.git.diffAll,
              changedFiles: context.git.defaultBase.pipe(
                Effect.flatMap((base) => context.git.changedFilesVsBase(base))
              ),
              events: context.events,
              ...(testsTask
                ? buildGate === undefined
                  ? {}
                  : { lint: buildGate }
                : testGate === undefined
                  ? {}
                  : { lint: testGate }),
              parallelism: 1
            })
            if (testsTask && testGate !== undefined) {
              const red = yield* testGate
              if (red.isClean) {
                return yield* FlowAborted.make({
                  message:
                    "the new acceptance tests pass before any implementation — they encode nothing"
                })
              }
            }
            yield* context.git.commitAll(`${plan.epicId}: ${task.title}`).pipe(Effect.asVoid)
          })
        )

        // The task loop marks each task complete AFTER its per-task commit, so
        // the final task's plan update would otherwise be left uncommitted.
        // A no-op when the loop already committed everything.
        yield* context.git.commitAll(`${plan.epicId}: plan state`).pipe(Effect.asVoid)

        if (verifyGate !== undefined) {
          yield* stage(
            context.events,
            "verify",
            Effect.gen(function* () {
              const result = yield* verifyGate
              if (!result.isClean) {
                return yield* FlowAborted.make({
                  message: `verify gate failed:\n${issueText(result.issues)}`
                })
              }
            })
          )
        }

        // The branch-level judge: bounded rounds of feedback, each re-gated and
        // committed, failing the flow if the bar is never cleared.
        yield* stage(
          context.events,
          "judge",
          Effect.gen(function* () {
            const contractText = yield* gatherSpecs(target, pack.specsDir)
            const complianceJudge = judge(context.reasoning, complianceDimensions)
            const rounds = judgeRounds()
            for (let round = 1; round <= rounds; round += 1) {
              const base = yield* context.git.defaultBase
              const diff = yield* context.git.diffVsBase(base)
              const scored = yield* complianceJudge
                .evaluate(
                  Sample.make({
                    response: diff,
                    context: contractText,
                    query: input.prompt
                  })
                )
                .pipe(Effect.mapError(FlowLlmError.from))
              const below = scored.scores.filter((score) => {
                const max = complianceDimensions.find((d) => d.name === score.name)?.maxScore ?? 2
                return score.score < max
              })
              if (below.length === 0) {
                return yield* context.events.publish(
                  Info.make({ message: "spec-compliance judge: branch cleared the bar" })
                )
              }
              if (round >= rounds) {
                return yield* FlowAborted.make({
                  message:
                    `spec-compliance judge not cleared after ${rounds} round(s):\n` +
                    below.map((d) => `- ${d.name} ${d.score}: ${d.reasoning}`).join("\n")
                })
              }
              yield* coderChat.ask(
                [
                  "The final spec-compliance review scored the branch below the bar. Close these gaps",
                  "without weakening any test, then stop:",
                  ...below.map((d) => `- ${d.name} (${d.score}): ${d.reasoning}`)
                ].join("\n")
              )
              if (verifyGate !== undefined) {
                const regated = yield* verifyGate
                if (!regated.isClean) {
                  return yield* FlowAborted.make({
                    message: "verify gate broke while addressing judge feedback"
                  })
                }
              }
              yield* context.git
                .commitAll(`${plan.epicId}: address spec-compliance feedback`)
                .pipe(Effect.asVoid)
            }
          })
        )

        // Publishing is best-effort: a repository with no remote or forge is a
        // normal local run, not a failure.
        yield* stage(
          context.events,
          "publish",
          Effect.gen(function* () {
            const base = yield* context.git.defaultBase
            yield* context.git.push("origin", plan.epicId)
            const pr = yield* context.hosting.createPr(
              `modernize: ${plan.epicId}`,
              `Implements the approved spec pack. Plan: ${ModDir}/plan.md — all gates green.`,
              base
            )
            yield* context.events.publish(Info.make({ message: `PR: ${pr.url}` }))
          }).pipe(
            Effect.catch((error) =>
              context.events.publish(
                Info.make({
                  message: `publish skipped (no remote/forge configured): ${error.message}`
                })
              )
            )
          )
        )
      })
  )
})

runFlowMain(program)
