// Legacy modernization phase 1: reverse-engineer the estate into a judged, human-approved spec pack.
//
// Runs rooted at the LEGACY repository (`--repo <legacy>`), after modernize-survey's
// wave plan is approved. Extraction is PER PROGRAM and resumable
// (`extractProgramsResumably` skips every program whose spec already exists —
// delete `specs/<NAME>.md` to re-extract one program): each program gets a
// structured analyst call producing its four artifacts — `specs/<NAME>.md`,
// `features/<name>.feature`, `traceability/<NAME>.md`, `mapping/<NAME>.md` —
// and its own commit. The estate-wide indexes (`traceability.md`, `mapping.md`)
// are regenerated deterministically from the fragments before every gate round.
//
// The gate is layered and nothing auto-approves: deterministic `SpecChecks`
// (every legacy coverage unit must appear in the traceability matrix; features
// must be well-formed Gherkin; both indexes present), then an LLM-as-a-Judge
// pass per program against the pack's rubrics with full marks required.
// Findings feed one bounded fix round per sub-bar program plus one estate-wide
// residual turn; a still-dirty pack is committed as an explicit DRAFT and the
// flow halts for human triage. Even a clean pack only gets an unchecked
// `- [ ] Approved` marker in `docs/modernization/README.md`.
//
// Pack: LLM4TS_PACK=<dir> (default packs/cobol-springboot, resolved against the
// launch dir, then against the flow's own directory — the built-in packs).
// LLM4TS_WAVE=<name> scopes the run to one wave of the approved plan. Judge
// context is bounded by LLM4TS_CONTEXT_BUDGET (chars;
// LLM4TS_JUDGE_SOURCES_LIMIT is the deprecated alias). The analyst is bounded
// by LLM4TS_ANALYST_TURNS and LLM4TS_MAX_CLOSURE_FILES.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { JsonSchema } from "@llm4ts/core/Models"
import { budget, capped, withShrink } from "@llm4ts/flow/Context"
import { FlowAborted, FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { FlowEvents, Info } from "@llm4ts/flow/FlowEvents"
import { makeChat } from "@llm4ts/flow/Chat"
import type { Pack } from "@llm4ts/flow/Pack"
import { loadPatternCards, matchingPatternCards } from "@llm4ts/flow/Patterns"
import { legacySourceWorkspaceLimits, workspaceLimitsFromEnv } from "@llm4ts/flow/Workspace"
import { stage } from "@llm4ts/flow/PlanExecution"
import { defaultPlanInstructions, planFrom } from "@llm4ts/flow/Planner"
import { ReviewIssue, ReviewResult, mergeReviewResults } from "@llm4ts/flow/Review"
import { cachedReview } from "@llm4ts/flow/ReviewCache"
import { coverage, coverageUnits, features, matchingFiles } from "@llm4ts/flow/SpecChecks"
import { SurveyGraph, closureFor, surveyGraph } from "@llm4ts/flow/Survey"
import { withDraftApproval, requireApproval } from "@llm4ts/modernize/Approval"
import {
  ProgramArtifacts,
  ProgramUnit,
  extractProgramsResumably
} from "@llm4ts/modernize/Artifacts"
import { asReadOnly, coderFromEnv, withTurnLimit } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { reviewFingerprint } from "@llm4ts/runner/ReviewFingerprint"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { loadUniversalPatternCards, openPack } from "@llm4ts/runner/Packs"

const ModDir = "docs/modernization"
const MaxRounds = 3

const positiveEnvInt = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// Per-program turn budget — bounds a wedged agent, generous for real work.
const analystTurns = (): number => positiveEnvInt("LLM4TS_ANALYST_TURNS", 48)

/**
 * Max files named in one program's include closure. A program pulling more
 * than this gets a bounded, visible subset rather than an unbounded read.
 */
const maxClosureFiles = (): number => positiveEnvInt("LLM4TS_MAX_CLOSURE_FILES", 40)

/** `cobol/ACCTXFR.cbl` → `ACCTXFR`: the program name keying every per-program artifact. */
const programName = (relativePath: string): string => {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}

/** The `- PROG` entries of `## Wave: <name>` in the survey's wave plan. */
const wavePrograms = (planText: string, wave: string): ReadonlyArray<string> => {
  const lines = planText.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## Wave: ${wave}`)
  if (start < 0) {
    return []
  }
  const section: Array<string> = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("## ")) {
      break
    }
    if (line.trim().startsWith("- ")) {
      section.push(line.trim().slice(2).trim())
    }
  }
  return section
}

const programArtifactsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    spec: { type: "string" },
    feature: { type: "string" },
    traceability: { type: "string" },
    mapping: { type: "string" }
  },
  required: ["spec", "feature", "traceability", "mapping"]
}

// The analyst gets a deterministically resolved include closure, not an open
// "read anything it references" instruction: told to chase references itself,
// the coding agent pulls files into its own context inside a single turn —
// which is how extract blew a 1M-token window while its own cap sat untouched.
const programAsk = (pack: Pack, relativePath: string, closure: ReadonlyArray<string>): string =>
  [
    `Extract the behavioural spec for ONE source unit of this repository: ${relativePath}`,
    "",
    ...(closure.length === 0
      ? [`Read ${relativePath}. It has no resolved dependencies.`]
      : [
          `Read ${relativePath} and EXACTLY these resolved dependencies — do not go looking for others:`,
          ...closure.map((file) => `- ${file}`)
        ]),
    `Spec ONLY ${relativePath} and do not modify legacy sources.`,
    "",
    'Respond only with JSON: {"spec":"…","feature":"…","traceability":"…","mapping":"…"} where:',
    "",
    `- "spec" — the behavioural spec for ${relativePath}, as Markdown.`,
    pack.prompt("spec") ?? "",
    "",
    `- "feature" — BDD scenarios encoding that spec, as a well-formed Gherkin .feature file`,
    "  (Feature: header, Scenario: blocks, Given/When/Then steps).",
    pack.prompt("bdd") ?? "",
    "",
    `- "traceability" — EVERY source unit of ${relativePath} (each COBOL paragraph, each JCL`,
    "  step) on its own line, mapped to the spec rules/scenarios that cover it:",
    "  `<UNIT-NAME> — <refs>`. Unit names verbatim as they appear in the source.",
    "",
    `- "mapping" — data & interface mapping for ${relativePath}: tables/record layouts → target`,
    "  entities; files/screens/queues → target service contracts."
  ].join("\n")

/** Sub-bar judge dimensions as Critical review issues, titled with their program. */
const judgeIssues = (
  pack: Pack,
  scored: {
    readonly scores: ReadonlyArray<{
      readonly name: string
      readonly score: number
      readonly reasoning: string
    }>
  },
  program: string
): ReviewResult => {
  const issues = scored.scores.flatMap((score) => {
    const maxScore = pack.judgeDimensions.find((d) => d.name === score.name)?.maxScore ?? 2
    return score.score < maxScore
      ? [
          ReviewIssue.make({
            severity: "Critical",
            title: `judge[${program}]: ${score.name} scored ${score.score}`,
            description: score.reasoning
          })
        ]
      : []
  })
  return ReviewResult.make({ issues, summary: `judge:${program}` })
}

const judgeIssueProgram = (issue: ReviewIssue): string | undefined =>
  /^judge\[([^\]]+)\]: /.exec(issue.title)?.[1]

const issueLines = (issues: ReadonlyArray<ReviewIssue>): string =>
  issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`).join("\n")

const programFixAsk = (
  name: string,
  relativePath: string,
  issues: ReadonlyArray<ReviewIssue>
): string =>
  [
    `The spec pack for ONE program did not clear its quality gate: ${name} (source: ${relativePath}).`,
    `Fix these findings by editing ONLY this program's files — ${ModDir}/specs/${name}.md,`,
    `${ModDir}/features/${name.toLowerCase()}.feature, ${ModDir}/traceability/${name}.md,`,
    `${ModDir}/mapping/${name}.md — against the source at ${relativePath}. Then stop:`,
    issueLines(issues)
  ].join("\n")

const globalFixAsk = (issues: ReadonlyArray<ReviewIssue>): string =>
  [
    "The spec pack did not clear its estate-wide quality gate. Fix these findings by editing the",
    `per-program files under ${ModDir}/ (specs/, features/, traceability/<PROGRAM>.md,`,
    `mapping/<PROGRAM>.md). ${ModDir}/traceability.md and ${ModDir}/mapping.md are REGENERATED`,
    "from the fragments — do not edit them directly. Fix the findings in place, then stop:",
    issueLines(issues)
  ].join("\n")

const readmeFor = (pack: Pack, verdict: string): string =>
  [
    `# Modernization spec pack — ${pack.name}`,
    "",
    `Extracted by the modernize-extract flow. Gate verdict: ${verdict}.`,
    "",
    "- specs/ — behavioural specs, one per program",
    "- features/ — BDD acceptance scenarios",
    "- traceability.md — source-unit → spec coverage matrix (generated from traceability/)",
    "- mapping.md — data & interface mapping (generated from mapping/)",
    "- rules.txt — every coverage unit, one per line (the rule universe verification reports against)",
    "- plan.md — proposed implementation tasks",
    "",
    "Review everything, then flip the marker below and run the seed phase."
  ].join("\n")

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Extract the complete behavioural spec pack for this legacy estate"
  )
  const coder = withTurnLimit(coderFromEnv(process.env), analystTurns())
  const files = nodePlainFileStore
  const modDirAbs = join(input.workDir, ModDir)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const repo = yield* makeNodeWorkspace(
          input.workDir,
          workspaceLimitsFromEnv(process.env, legacySourceWorkspaceLimits)
        )
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
          "branch",
          context.git.checkoutOrCreate("modernize/spec-pack").pipe(Effect.asVoid)
        )
        const system = [
          pack.prompt("analysis"),
          pack.lessons === undefined
            ? undefined
            : `Lessons from previous modernization runs — apply them:\n${pack.lessons}`
        ]
          .filter((part) => part !== undefined)
          .join("\n\n")

        const all = yield* stage(
          context.events,
          "inventory",
          matchingFiles(repo, pack.programs ?? pack.sources ?? ".*", pack.exclude)
        )
        const wave = process.env.LLM4TS_WAVE?.trim()
        const programs =
          wave === undefined || wave.length === 0
            ? all
            : yield* Effect.gen(function* () {
                yield* stage(
                  context.events,
                  "wave approval",
                  requireApproval(files, join(modDirAbs, "wave-plan.md"))
                )
                const planText = (yield* files.read(join(modDirAbs, "wave-plan.md"))) ?? ""
                const names = new Set(wavePrograms(planText, wave))
                const scoped = all.filter((rel) => names.has(programName(rel)))
                if (scoped.length === 0) {
                  return yield* FlowAborted.make({
                    message: `wave '${wave}' matches no programs in ${ModDir}/wave-plan.md`
                  })
                }
                return scoped
              })
        if (programs.length === 0) {
          return yield* FlowAborted.make({
            message: `no source units matched the pack's programs/sources regex under ${input.workDir}`
          })
        }

        const units = programs.map((rel) =>
          ProgramUnit.make({ name: programName(rel), sourcePath: rel })
        )

        // Pattern cards are selected deterministically from the SOURCE, never by
        // the model: implementation later injects exactly the cards cited here.
        const cards = [
          ...(yield* loadPatternCards(opened.workspace, `${opened.dir}/patterns`)),
          ...(yield* loadUniversalPatternCards([input.workspace, import.meta.dirname]))
        ]

        // The dependency graph the analysts' include closures are resolved
        // from — walked over the pack's `## Survey:` edge regexes.
        const graph = yield* stage(
          context.events,
          "graph",
          pack.survey.length === 0
            ? context.events
                .publish(
                  Info.make({
                    message:
                      "pack has no '## Survey:' edge regexes — the analyst gets no resolved closure"
                  })
                )
                .pipe(Effect.as(SurveyGraph.make({ nodes: [], edges: [] })))
            : surveyGraph(repo, pack.sources ?? ".*", pack.coverage, pack.survey, {
                ...(pack.exclude === undefined ? {} : { exclude: pack.exclude })
              })
        )

        // One structured analyst call per program, resumable per program: a rerun
        // skips every program whose spec exists, and each program gets its own commit.
        yield* stage(
          context.events,
          "extract",
          Effect.gen(function* () {
            for (const [index, unit] of units.entries()) {
              const summary = yield* extractProgramsResumably(
                files,
                [unit],
                (target) =>
                  Effect.gen(function* () {
                    yield* context.events.publish(
                      Info.make({
                        message: `extracting ${target.sourcePath} (${index + 1}/${units.length})`
                      })
                    )
                    return yield* structuredAndPublish(
                      context.coder,
                      context.events,
                      `${system}\n\n${programAsk(
                        pack,
                        target.sourcePath,
                        closureFor(graph, target.name, maxClosureFiles())
                      )}`,
                      ProgramArtifacts,
                      programArtifactsJsonSchema,
                      "coder"
                    ).pipe(
                      // A turn-limit trip is the wedged-agent tail, not a
                      // failure: keep whatever the analyst already produced.
                      Effect.catchIf(
                        (error) => error.cause?._tag === "TurnLimitError",
                        (error) =>
                          Effect.gen(function* () {
                            const existing = yield* files.read(
                              join(modDirAbs, "specs", `${target.name}.md`)
                            )
                            if (existing === undefined) {
                              return yield* Effect.fail(error)
                            }
                            yield* context.events.publish(
                              Info.make({
                                message: `turn limit hit on ${target.sourcePath} after its spec was written — keeping the work`
                              })
                            )
                            return ProgramArtifacts.make({
                              spec: existing,
                              feature: "",
                              traceability: "",
                              mapping: ""
                            })
                          })
                      )
                    )
                  }),
                modDirAbs
              )
              if (summary.created.length > 0) {
                // Tag the traceability fragment with the cards this program's
                // source matches — regex-decided, so implementation's playbook
                // is reproducible.
                const source = yield* files.read(join(input.workDir, unit.sourcePath))
                const matched = source === undefined ? [] : matchingPatternCards(source, cards)
                if (matched.length > 0) {
                  const fragmentPath = join(modDirAbs, "traceability", `${unit.name}.md`)
                  const fragment = (yield* files.read(fragmentPath)) ?? ""
                  yield* files.writeAtomic(
                    fragmentPath,
                    `${fragment.trimEnd()}\n\nPatterns: ${matched.map((card) => card.id).join(", ")}\n`
                  )
                }
                yield* context.git
                  .commitAll(`modernize(${pack.name}): spec ${unit.name}`)
                  .pipe(Effect.asVoid)
              } else {
                yield* context.events.publish(
                  Info.make({
                    message: `resume: specs/${unit.name}.md exists — skipping ${unit.sourcePath}`
                  })
                )
              }
            }
          })
        )

        // traceability.md / mapping.md are regenerated from the fragments — fixes
        // belong in the fragments, never the indexes.
        const rebuildIndexes = Effect.gen(function* () {
          for (const [fragmentDir, index] of [
            ["traceability", "traceability.md"],
            ["mapping", "mapping.md"]
          ] as const) {
            const parts: Array<string> = []
            for (const unit of units) {
              const text = yield* files.read(join(modDirAbs, fragmentDir, `${unit.name}.md`))
              if (text !== undefined && text.trim().length > 0) {
                parts.push(`===== ${unit.name} =====\n${text.trimEnd()}`)
              }
            }
            if (parts.length > 0) {
              yield* files.writeAtomic(join(modDirAbs, index), parts.join("\n\n") + "\n")
            }
          }
        })

        const writeRules = Effect.gen(function* () {
          const unitsByRule = yield* coverageUnits(repo, pack.coverage)
          const allUnits = [...new Set(Object.values(unitsByRule).flat())].sort()
          if (allUnits.length > 0) {
            yield* files.writeAtomic(join(modDirAbs, "rules.txt"), allUnits.join("\n") + "\n")
          }
        })

        // Commit the (ungated) draft: extraction is the expensive step, and a gate
        // failure or crash must not cost it.
        yield* stage(
          context.events,
          "draft",
          rebuildIndexes.pipe(
            Effect.andThen(writeRules),
            Effect.andThen(
              context.git
                .commitAll(`modernize(${pack.name}): spec pack draft (ungated)`)
                .pipe(Effect.asVoid)
            )
          )
        )

        const packJudge = judge(context.reasoning, pack.judgeDimensions)
        const limit = budget()

        // The shared Context ladder: an oversized prompt retries at half, then
        // quarter budget (repeating it identically cannot succeed), and every
        // cap or shrink is recorded and published.
        const judgeWithShrink = (
          name: string,
          spec: string,
          feature: string,
          source: string
        ): Effect.Effect<EvalResult, FlowError> =>
          withShrink(
            `judge[${name}]`,
            (cap) =>
              Effect.gen(function* () {
                const response = yield* capped(`spec[${name}]`, `${spec}\n\n${feature}`, cap)
                const source_ = yield* capped(`source[${name}]`, source, cap)
                return yield* packJudge
                  .evaluate(Sample.make({ response, context: source_, query: input.prompt }))
                  .pipe(Effect.mapError(FlowLlmError.from))
              }),
            { start: limit }
          ).pipe(Effect.provideService(FlowEvents, context.events))

        /**
         * Judging is resumable per program: the verdict persists under
         * `gate/<NAME>.json`, fingerprinted over the source, spec, feature, and
         * rubric it judged. Unchanged content reuses the stored verdict with NO
         * model call, so a crash or quota death re-judges only what changed.
         * Delete `gate/` to force a full re-judge.
         */
        const judgeProgram = (unit: ProgramUnit) =>
          Effect.gen(function* () {
            const spec = (yield* files.read(join(modDirAbs, "specs", `${unit.name}.md`))) ?? ""
            const feature =
              (yield* files.read(
                join(modDirAbs, "features", `${unit.name.toLowerCase()}.feature`)
              )) ?? ""
            const source = (yield* files.read(join(input.workDir, unit.sourcePath))) ?? ""
            const rubric = pack.judgeDimensions
              .map(
                (dimension) => `${dimension.name} (0..${dimension.maxScore}): ${dimension.rubric}`
              )
              .join("\n")
            return yield* cachedReview(
              files,
              join(modDirAbs, "gate", `${unit.name}.json`),
              reviewFingerprint(source, spec, feature, rubric),
              context.events.publish(Info.make({ message: `judging ${unit.name}` })).pipe(
                Effect.andThen(judgeWithShrink(unit.name, spec, feature, source)),
                Effect.map((scored) => judgeIssues(pack, scored, unit.name))
              )
            )
          })

        const gateEvaluate = Effect.gen(function* () {
          yield* rebuildIndexes
          const trace = (yield* files.read(join(modDirAbs, "traceability.md"))) ?? ""
          const mapping = (yield* files.read(join(modDirAbs, "mapping.md"))) ?? ""
          const docs = ReviewResult.make({
            issues: [
              ...(trace.trim().length === 0
                ? [
                    ReviewIssue.make({
                      severity: "Critical",
                      title: "missing traceability",
                      description: `no ${ModDir}/traceability/ fragments were written`
                    })
                  ]
                : []),
              ...(mapping.trim().length === 0
                ? [
                    ReviewIssue.make({
                      severity: "Critical",
                      title: "missing mapping",
                      description: `no ${ModDir}/mapping/ fragments were written`
                    })
                  ]
                : [])
            ],
            summary: "docs"
          })
          const covered = yield* coverage(repo, pack.coverage, trace)
          const wellFormed = yield* features(repo, join(ModDir, "features"))
          const judged: Array<ReviewResult> = []
          for (const unit of units) {
            judged.push(yield* judgeProgram(unit))
          }
          return mergeReviewResults([covered, wellFormed, docs, ...judged])
        })

        // One bounded fix turn per sub-bar program (own commit) plus one residual
        // estate-wide turn, then re-evaluate — up to MaxRounds evaluations.
        const fixOnce = (result: ReviewResult) =>
          Effect.gen(function* () {
            const relOf = new Map(units.map((unit) => [unit.name, unit.sourcePath]))
            const scoped = new Map<string, Array<ReviewIssue>>()
            const global: Array<ReviewIssue> = []
            for (const issue of result.issues) {
              const name = judgeIssueProgram(issue)
              if (name !== undefined && relOf.has(name)) {
                const bucket = scoped.get(name) ?? []
                bucket.push(issue)
                scoped.set(name, bucket)
              } else {
                global.push(issue)
              }
            }
            const turn = (ask: string, commitMessage: string) =>
              Effect.gen(function* () {
                const chat = yield* makeChat(context.coder, { system })
                yield* chat.ask(ask).pipe(
                  Effect.asVoid,
                  // A wedged agent that trips its turn limit mid-fix still wrote
                  // something; re-evaluate what landed instead of failing.
                  Effect.catchIf(
                    (error) => error._tag === "Llm" && error.cause?._tag === "TurnLimitError",
                    () =>
                      context.events.publish(
                        Info.make({
                          message:
                            "turn limit hit during a fix turn — re-evaluating what was written"
                        })
                      )
                  )
                )
                yield* context.git.commitAll(commitMessage).pipe(Effect.asVoid)
              })
            for (const [name, issues] of [...scoped.entries()].sort()) {
              yield* context.events.publish(
                Info.make({ message: `fixing ${name} — ${issues.length} finding(s)` })
              )
              const relativePath = relOf.get(name)
              if (relativePath !== undefined) {
                yield* turn(
                  programFixAsk(name, relativePath, issues),
                  `modernize(${pack.name}): gate fixes ${name}`
                )
              }
            }
            if (global.length > 0) {
              yield* context.events.publish(
                Info.make({ message: `fixing estate-wide findings — ${global.length}` })
              )
              yield* turn(globalFixAsk(global), `modernize(${pack.name}): gate fixes (estate-wide)`)
            }
          })

        let result = yield* stage(context.events, "gate", gateEvaluate)
        for (let round = 2; round <= MaxRounds && result.issues.length > 0; round += 1) {
          yield* stage(context.events, `gate fixes (round ${round})`, fixOnce(result))
          result = yield* stage(context.events, `gate (round ${round})`, gateEvaluate)
        }

        if (result.issues.length === 0) {
          yield* stage(
            context.events,
            "plan",
            Effect.gen(function* () {
              const specTexts: Array<string> = []
              for (const unit of units) {
                const spec = yield* files.read(join(modDirAbs, "specs", `${unit.name}.md`))
                if (spec !== undefined) {
                  specTexts.push(spec)
                }
              }
              const plannerSpecs = yield* capped("plan specs", specTexts.join("\n\n"), limit).pipe(
                Effect.provideService(FlowEvents, context.events)
              )
              const plan = yield* planFrom(
                context.reasoning,
                plannerSpecs,
                `${defaultPlanInstructions}\n\n${pack.prompt("plan") ?? ""}`
              )
              yield* files.writeAtomic(join(modDirAbs, "plan.md"), plan.render)
            })
          )
        }

        const verdict =
          result.issues.length === 0
            ? "PASSED — pending human approval"
            : `DRAFT — ${result.issues.length} open issue(s)`
        yield* stage(
          context.events,
          "commit",
          files
            .writeAtomic(join(modDirAbs, "README.md"), withDraftApproval(readmeFor(pack, verdict)))
            .pipe(
              Effect.andThen(
                context.git
                  .commitAll(`modernize(${pack.name}): spec pack (${verdict})`)
                  .pipe(Effect.asVoid)
              )
            )
        )

        if (result.issues.length > 0) {
          return yield* FlowAborted.make({
            message:
              `extraction gate not cleared after ${MaxRounds} round(s) — spec pack committed as draft:\n` +
              result.issues.map((issue) => `- ${issue.title}`).join("\n")
          })
        }
        yield* context.events.publish(
          Info.make({
            message:
              `spec pack ready — review ${ModDir}/README.md, set '- [x] Approved', ` +
              "then run the seed phase"
          })
        )
      })
  )
})

runFlowMain(program)
