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
import { Dimension, Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { Evaluator } from "@llm4ts/core/eval/Evaluator"
import { makeChat } from "@llm4ts/flow/Chat"
import { capped, renderTruncation, truncations, withShrink } from "@llm4ts/flow/Context"
import { FlowAborted, FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { FlowEvents, Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { judgeAllPrograms } from "@llm4ts/flow/ProgramJudge"
import { Provenance, makeProvenanceStore } from "@llm4ts/flow/Provenance"
import { loadPatternCards, taggedPatternIds } from "@llm4ts/flow/Patterns"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { implementTaskLoop, stage } from "@llm4ts/flow/PlanExecution"
import {
  ReviewIssue,
  ReviewResult,
  lintCommand,
  mergeReviewResults,
  minimalReviewers,
  reviewAndFixLoop
} from "@llm4ts/flow/Review"
import { checkWall, wallBreachMessage } from "@llm4ts/flow/Wall"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { reviewFingerprint } from "@llm4ts/runner/ReviewFingerprint"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { loadUniversalPatternCards, openPack } from "@llm4ts/runner/Packs"

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

/** The spec'd programs: top-level `<NAME>.md` under the specs dir, indexes aside. */
const specPrograms = Effect.fn("modernize-implement.specPrograms")(function* (
  target: WorkspaceShape,
  specsDir: string
) {
  const paths = yield* target.discover(`${specsDir}/*.md`).pipe(Effect.orElseSucceed(() => []))
  return [...paths]
    .map((path) => path.split("/").at(-1) ?? path)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter((name) => !["traceability", "mapping", "README"].includes(name))
    .sort()
})

/**
 * One bounded estate-wide pass: the traceability index plus the changed-file
 * NAMES (never contents). Per-program judging cannot see cross-program
 * problems — a rule that moved between programs, a scenario orphaned when two
 * programs were merged — because each of its calls only ever sees one
 * program's slice of the diff. This pass is the compensating check. Both
 * parts are capped, not just the index: on a full-estate branch the
 * changed-file name list alone can run to five figures of lines.
 */
const traceabilityPass = (
  complianceJudge: Evaluator<Sample>,
  dimensions: ReadonlyArray<Dimension>,
  trace: string,
  changedFiles: ReadonlyArray<string>,
  userPrompt: string
): Effect.Effect<ReviewResult, FlowError, FlowEvents> =>
  withShrink("judge[traceability]", (cap) =>
    Effect.gen(function* () {
      const cappedTrace = yield* capped("traceability", trace, Math.floor(cap / 2))
      const cappedNames = yield* capped(
        "changed files",
        `Files changed on this branch:\n${changedFiles.join("\n")}`,
        Math.floor(cap / 2)
      )
      return yield* complianceJudge
        .evaluate(Sample.make({ response: cappedNames, context: cappedTrace, query: userPrompt }))
        .pipe(Effect.mapError(FlowLlmError.from))
    })
  ).pipe(Effect.map((scored: EvalResult) => traceabilityIssues(scored, dimensions)))

const traceabilityIssues = (
  scored: EvalResult,
  dimensions: ReadonlyArray<Dimension>
): ReviewResult => {
  const subBar = scored.scores.filter(
    (score) =>
      score.score < (dimensions.find((dimension) => dimension.name === score.name)?.maxScore ?? 2)
  )
  return ReviewResult.make({
    issues: subBar.map((score) =>
      ReviewIssue.make({
        severity: "Critical",
        title: `judge[traceability]: ${score.name} scored ${score.score}`,
        description: score.reasoning
      })
    ),
    summary: "judge:traceability"
  })
}

/**
 * Append this run's recorded context truncations to the manifest, so a
 * verdict rendered on a partially-read spec pack says so in the evidence
 * chain rather than only in the console log. A repo seeded before provenance
 * existed simply has no manifest — skip rather than fail.
 */
const recordTruncations = (
  manifestPath: string,
  events: FlowEventsShape
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const recorded = yield* truncations
    if (recorded.length === 0) {
      return
    }
    const store = makeProvenanceStore(nodePlainFileStore)
    yield* store
      .extend(manifestPath, (current) =>
        Provenance.make({
          ...current,
          contextTruncations: [...current.contextTruncations, ...recorded.map(renderTruncation)]
        })
      )
      .pipe(
        Effect.asVoid,
        Effect.catch(() =>
          events.publish(
            Info.make({ message: "no provenance.json — seeded by an older run; skipping" })
          )
        )
      )
  })

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Implement the seeded modernization plan")
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
          ...(yield* loadPatternCards(opened.workspace, `${opened.dir}/patterns`)),
          ...(yield* loadUniversalPatternCards([input.workspace, import.meta.dirname]))
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

        const firstTitle = plan.tasks[0]?.title

        // One chat per task: `Chat` replays its full message list on each ask,
        // so a shared chat would carry every earlier task's transcript into
        // task N's prompt. The repo, not the transcript, carries state between
        // tasks.
        yield* implementTaskLoop(store, context.events, planPath, plan, (task) =>
          Effect.gen(function* () {
            const testsTask = task.title === firstTitle
            const coderChat = yield* makeChat(context.coder, { system })
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

        // The spec-compliance judge, decomposed: one ProgramJudge pass per
        // program's own slice of the diff (cached, resumable), plus one
        // bounded traceability pass over the whole estate — never the whole
        // spec pack times the whole branch diff in a single call. Bounded
        // rounds of feedback, each re-gated and committed, failing the flow
        // if the bar is never cleared.
        yield* stage(
          context.events,
          "judge",
          Effect.gen(function* () {
            const complianceJudge = judge(context.reasoning, complianceDimensions)
            const specsDirAbs = join(input.workDir, pack.specsDir)
            const gateDir = join(input.workDir, ModDir, "gate")
            const rounds = judgeRounds()
            for (let round = 1; round <= rounds; round += 1) {
              const base = yield* context.git.defaultBase
              const programs = yield* specPrograms(target, pack.specsDir)
              const perProgram = yield* judgeAllPrograms({
                pack,
                judge: complianceJudge,
                dimensions: complianceDimensions,
                git: context.git,
                files,
                gateDir,
                base,
                programs,
                specFor: (program) =>
                  files
                    .read(join(specsDirAbs, `${program}.md`))
                    .pipe(Effect.map((text) => text ?? "")),
                query: input.prompt,
                fingerprint: reviewFingerprint
              })
              const trace = yield* files
                .read(join(specsDirAbs, "traceability.md"))
                .pipe(Effect.map((text) => text ?? ""))
              const changed = yield* context.git.changedFilesVsBase(base)
              const traced = yield* traceabilityPass(
                complianceJudge,
                complianceDimensions,
                trace,
                changed,
                input.prompt
              )
              const merged = mergeReviewResults([perProgram, traced])
              if (merged.isClean) {
                return yield* context.events.publish(
                  Info.make({ message: "spec-compliance judge: branch cleared the bar" })
                )
              }
              if (round >= rounds) {
                return yield* FlowAborted.make({
                  message:
                    `spec-compliance judge not cleared after ${rounds} round(s):\n` +
                    merged.issues.map((i) => `- ${i.title}: ${i.description}`).join("\n")
                })
              }
              // Feedback goes to a FRESH chat: the judge findings carry their
              // own context, and replaying the whole implementation transcript
              // is exactly the accumulation this flow no longer does.
              const feedbackChat = yield* makeChat(context.coder, { system })
              yield* feedbackChat.ask(
                [
                  "The final spec-compliance review scored the branch below the bar. Close these gaps",
                  "without weakening any test, then stop:",
                  ...merged.issues.map((i) => `- ${i.title}: ${i.description}`)
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
          }).pipe(Effect.provideService(FlowEvents, context.events))
        )

        // Truncations recorded while judging land in the evidence chain, and
        // the per-program verdict cache is committed with them: it is part of
        // the evidence, and a rerun on a fresh clone resumes from it.
        yield* recordTruncations(join(input.workDir, ModDir, "provenance.json"), context.events)
        yield* context.git.commitAll(`${plan.epicId}: judge verdicts`).pipe(Effect.asVoid)

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
