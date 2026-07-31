// Legacy modernization phase 5: review the increment against its spec pack and distil lessons.
//
// Runs rooted at the TARGET repository (`--repo <target>`) behind the enforced
// clean-room wall — the review judges spec-driven work only.
//
//   1. The full reviewer roster plus the pack's own lenses (filtered to the
//      files this branch touched) review the diff against the committed specs.
//   2. A spec-compliance judge scores the branch on the same two dimensions
//      modernize-implement gates on.
//   3. Findings and scores are distilled into: fixes (spec VIOLATIONS, which
//      become fix specs plus plan tasks for another implement pass),
//      improvements (worthwhile but not violations), and lessons — rules of
//      thumb that generalize, appended to the pack's lessons.md so the next
//      estate starts smarter.
//
// Run: modernize-review --repo ~/services/meridian-transfers
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Dimension, Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { JsonSchema } from "@llm4ts/core/Models"
import { FlowAborted, FlowLlmError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { appendPackLesson, type Pack } from "@llm4ts/flow/Pack"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { stage } from "@llm4ts/flow/PlanExecution"
import {
  allReviewers,
  mergeReviewResults,
  reviewJsonSchema,
  reviewPrompt,
  ReviewResult
} from "@llm4ts/flow/Review"
import { checkWall, wallBreachMessage } from "@llm4ts/flow/Wall"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { openPack } from "@llm4ts/runner/Packs"

const ModDir = "docs/modernization"

class FixSpec extends Schema.Class<FixSpec>("FixSpec")({
  title: Schema.String,
  spec: Schema.String,
  taskTitle: Schema.String,
  taskDescription: Schema.String
}) {}

class ReviewOutcome extends Schema.Class<ReviewOutcome>("ReviewOutcome")({
  fixes: Schema.Array(FixSpec),
  improvements: Schema.Array(FixSpec),
  lessons: Schema.Array(Schema.String)
}) {}

const fixSpecJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    spec: { type: "string" },
    taskTitle: { type: "string" },
    taskDescription: { type: "string" }
  },
  required: ["title", "spec", "taskTitle", "taskDescription"]
} as const

const reviewOutcomeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    fixes: { type: "array", items: { ...fixSpecJsonSchema } },
    improvements: { type: "array", items: { ...fixSpecJsonSchema } },
    lessons: { type: "array", items: { type: "string" } }
  },
  required: ["fixes", "improvements", "lessons"]
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
      "Is every BDD scenario in the seeded feature files exercised by an acceptance test on this branch?"
  })
]

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)

const gatherDir = Effect.fn("modernize-review.gatherDir")(function* (
  workspace: WorkspaceShape,
  directory: string
) {
  const paths = yield* workspace.discover(`${directory}/**`).pipe(Effect.orElseSucceed(() => []))
  const parts: Array<string> = []
  for (const path of [...paths].sort()) {
    const text = yield* workspace.read(path).pipe(Effect.orElseSucceed(() => ""))
    if (text.trim().length > 0) {
      parts.push(`===== ${path} =====\n${text}`)
    }
  }
  return parts.join("\n\n")
})

const distillPrompt = (
  pack: Pack,
  findings: ReviewResult,
  scored: EvalResult,
  diff: string
): string =>
  [
    pack.prompt("review") ?? "",
    "",
    "Below are the raw reviewer findings and judge scores for a modernization increment.",
    "Distill them:",
    '- "fixes": findings where the implementation VIOLATES the committed specs. Each gets a',
    "  short spec document (Markdown: what is wrong, the spec rule it violates, the expected",
    "  behaviour) and a plan task (title + description naming the spec rules/scenarios).",
    '- "improvements": worthwhile follow-ups that do NOT violate the specs.',
    '- "lessons": rules of thumb that would help FUTURE modernizations of this kind — phrased',
    "  generally (no file paths from this repo), one sentence each. Only include lessons that",
    "  generalize; an empty list is a fine answer.",
    "",
    "Reviewer findings:",
    findings.issues
      .map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`)
      .join("\n"),
    "",
    "Judge scores:",
    scored.scores.map((score) => `- ${score.name}: ${score.score} — ${score.reasoning}`).join("\n"),
    "",
    "Diff under review:",
    diff
  ].join("\n")

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Review the modernization increment against its spec pack")
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
        const target = yield* makeNodeWorkspace(input.workDir)
        const opened = yield* stage(
          context.events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )
        const pack = opened.pack
        const reviewService = context.reviewers[0] ?? context.reasoning

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
                  "The review must judge spec-driven work only; remove the files and rerun."
                )
              })
            }
            yield* context.events.publish(
              Info.make({ message: "clean-room wall: no legacy source in the target workspace" })
            )
          })
        )

        const base = yield* context.git.defaultBase
        const diff = yield* context.git.diffVsBase(base)
        if (diff.trim().length === 0) {
          return yield* FlowAborted.make({
            message: `nothing to review: no diff vs ${base} on this branch`
          })
        }
        const changedFiles = yield* context.git.changedFilesVsBase(base)
        const specText = yield* gatherDir(target, pack.specsDir)

        const findings = yield* stage(
          context.events,
          "review",
          Effect.gen(function* () {
            // Sequential on purpose: free provider tiers rate-limit concurrent
            // reviewers, and the roster is small.
            const roster = [...allReviewers, ...pack.lenses].filter((lens) =>
              lens.matches(changedFiles)
            )
            const results: Array<ReviewResult> = []
            for (const lens of roster) {
              const prompt = `${lens.systemPrompt}\n\n${reviewPrompt(
                `modernization increment vs committed specs\n\n${specText}`,
                diff
              )}`
              results.push(
                yield* reviewService
                  .executeStructured(prompt, ReviewResult, reviewJsonSchema)
                  .pipe(Effect.mapError(FlowLlmError.from))
              )
            }
            return mergeReviewResults(results)
          })
        )

        const scored = yield* stage(
          context.events,
          "judge",
          judge(context.reasoning, complianceDimensions)
            .evaluate(Sample.make({ response: diff, context: specText, query: input.prompt }))
            .pipe(Effect.mapError(FlowLlmError.from))
        )

        const outcome = yield* stage(
          context.events,
          "distill",
          context.reasoning
            .executeStructured(
              distillPrompt(pack, findings, scored, diff),
              ReviewOutcome,
              reviewOutcomeJsonSchema
            )
            .pipe(Effect.mapError(FlowLlmError.from))
        )

        yield* stage(
          context.events,
          "fix specs",
          Effect.gen(function* () {
            const documents: ReadonlyArray<readonly [string, FixSpec]> = [
              ...outcome.fixes.map((fix) => ["fix", fix] as const),
              ...outcome.improvements.map((fix) => ["improvement", fix] as const)
            ]
            for (const [kind, fix] of documents) {
              yield* files.writeAtomic(
                join(input.workDir, pack.specsDir, "fixes", `${kind}-${slug(fix.title)}.md`),
                `# ${fix.title}\n\n${fix.spec}\n`
              )
            }
            if (outcome.fixes.length === 0) {
              return yield* context.events.publish(
                Info.make({ message: "no spec violations — no plan increment" })
              )
            }
            const store = makePlanStore(files)
            const plan = yield* store.load(planPath)
            if (plan === undefined) {
              return yield* FlowAborted.make({
                message: `no plan at ${planPath} — run modernize-seed first`
              })
            }
            yield* store.save(
              planPath,
              Plan.make({
                ...plan,
                tasks: [
                  ...plan.tasks,
                  ...outcome.fixes.map((fix) =>
                    Task.make({
                      title: fix.taskTitle,
                      description: fix.taskDescription,
                      completed: false
                    })
                  )
                ]
              })
            )
            yield* context.events.publish(
              Info.make({
                message: `${outcome.fixes.length} fix task(s) appended — rerun modernize-implement`
              })
            )
          })
        )

        yield* stage(
          context.events,
          "lessons",
          Effect.gen(function* () {
            if (outcome.lessons.length === 0) {
              return yield* context.events.publish(
                Info.make({ message: "no generalizable lessons this round" })
              )
            }
            for (const lesson of outcome.lessons) {
              yield* appendPackLesson(opened.workspace, opened.dir, lesson)
            }
            yield* context.events.publish(
              Info.make({
                message:
                  `${outcome.lessons.length} lesson(s) appended to ${opened.dir}/lessons.md — ` +
                  "review and commit the pack change"
              })
            )
          })
        )

        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(
              `modernize(${pack.name}): review — ${outcome.fixes.length} fix(es), ` +
                `${outcome.improvements.length} improvement(s)`
            )
            .pipe(Effect.asVoid)
        )
        yield* context.events.publish(
          Info.make({
            message:
              `fixes=${outcome.fixes.length} improvements=${outcome.improvements.length} ` +
              `lessons=${outcome.lessons.length}`
          })
        )
      })
  )
})

runFlowMain(program)
