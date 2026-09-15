// Shared core of the extraction phase: the per-program analyst ask, the
// per-program cached judge, the fix turn, and the spec-pack README. Used by
// `modernize-extract` (every program of a wave) and `modernize-refine`
// (one program at a time, deepened with a focus — ADR 0015).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { ProgramArtifacts, ProgramUnit } from "@llm4ts/flow/Artifacts"
import { capped, withShrink } from "@llm4ts/flow/Context"
import { type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowEvents } from "@llm4ts/flow/FlowEvents"
import type { Pack } from "@llm4ts/flow/Pack"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { ReviewIssue } from "@llm4ts/flow/Review"
import { cachedReview } from "@llm4ts/flow/ReviewCache"
import { FlowLlmError, Info, ReviewResult, makeChat, reviewFingerprint } from "@llm4ts/runner"

export const ModDir = "docs/modernization"

export const positiveEnvInt = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// Per-program turn budget — bounds a wedged agent, generous for real work.
export const analystTurns = (): number => positiveEnvInt("LLM4TS_ANALYST_TURNS", 48)

/**
 * Max files named in one program's include closure. A program pulling more
 * than this gets a bounded, visible subset rather than an unbounded read.
 */
export const maxClosureFiles = (): number => positiveEnvInt("LLM4TS_MAX_CLOSURE_FILES", 40)

/** `cobol/ACCTXFR.cbl` → `ACCTXFR`: the program name keying every per-program artifact. */
export const programName = (relativePath: string): string => {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}

/** The `- PROG` entries of `## Wave: <name>` in the survey's wave plan. */
export const wavePrograms = (planText: string, wave: string): ReadonlyArray<string> => {
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

export const programArtifactsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    spec: { type: "string" },
    feature: { type: "string" },
    traceability: { type: "string" },
    mapping: { type: "string" }
  },
  required: ["spec", "feature", "traceability", "mapping"]
}

/** The analyst's system prompt: the pack's analysis sidecar plus its lessons. */
export const analystSystem = (pack: Pack): string =>
  [
    pack.prompt("analysis"),
    pack.lessons === undefined
      ? undefined
      : `Lessons from previous modernization runs — apply them:\n${pack.lessons}`
  ]
    .filter((part) => part !== undefined)
    .join("\n\n")

/** A deepen pass: revise the previous artifacts with a mandatory focus (ADR 0015). */
export interface Revision {
  readonly previous: ProgramArtifacts
  readonly focus: string
}

// The analyst gets a deterministically resolved include closure, not an open
// "read anything it references" instruction: told to chase references itself,
// the coding agent pulls files into its own context inside a single turn —
// which is how extract blew a 1M-token window while its own cap sat untouched.
export const programAsk = (
  pack: Pack,
  relativePath: string,
  closure: ReadonlyArray<string>,
  revision?: Revision
): string =>
  [
    revision === undefined
      ? `Extract the behavioural spec for ONE source unit of this repository: ${relativePath}`
      : `DEEPEN the behavioural spec of ONE source unit of this repository: ${relativePath}`,
    "",
    ...(closure.length === 0
      ? [`Read ${relativePath}. It has no resolved dependencies.`]
      : [
          `Read ${relativePath} and EXACTLY these resolved dependencies — do not go looking for others:`,
          ...closure.map((file) => `- ${file}`)
        ]),
    `Spec ONLY ${relativePath} and do not modify legacy sources.`,
    ...(revision === undefined
      ? []
      : [
          "",
          "This is a REVISION, not a fresh extraction. Start from the previous artifacts below and",
          "revise them: keep every existing scenario title UNCHANGED unless the behaviour it names",
          "no longer exists in the source, add what is missing, correct what is wrong. The focus of",
          `this revision, which the result MUST address explicitly: ${revision.focus}`,
          "",
          "Previous spec:",
          revision.previous.spec,
          "",
          "Previous feature file:",
          revision.previous.feature,
          "",
          "Previous traceability fragment:",
          revision.previous.traceability,
          "",
          "Previous mapping fragment:",
          revision.previous.mapping
        ]),
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
export const judgeIssues = (
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

export const judgeIssueProgram = (issue: ReviewIssue): string | undefined =>
  /^judge\[([^\]]+)\]: /.exec(issue.title)?.[1]

export const issueLines = (issues: ReadonlyArray<ReviewIssue>): string =>
  issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`).join("\n")

export const programFixAsk = (
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

export const globalFixAsk = (issues: ReadonlyArray<ReviewIssue>): string =>
  [
    "The spec pack did not clear its estate-wide quality gate. Fix these findings by editing the",
    `per-program files under ${ModDir}/ (specs/, features/, traceability/<PROGRAM>.md,`,
    `mapping/<PROGRAM>.md). ${ModDir}/traceability.md and ${ModDir}/mapping.md are REGENERATED`,
    "from the fragments — do not edit them directly. Fix the findings in place, then stop:",
    issueLines(issues)
  ].join("\n")

/** The spec pack README; `notes` records what a refinement changed after the gate passed. */
export const readmeFor = (pack: Pack, verdict: string, notes: ReadonlyArray<string> = []): string =>
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
    "- decisions.md / domains.md — the refinement overlays, when modernize-refine has run (ADR 0015)",
    ...(notes.length === 0
      ? []
      : ["", "Refined after the gate passed:", ...notes.map((n) => `- ${n}`)]),
    "",
    "Review everything, then flip the marker below and run the seed phase."
  ].join("\n")

export interface ProgramJudgeDeps {
  readonly context: FlowContextShape
  readonly files: PlainFileStoreShape
  readonly pack: Pack
  /** Absolute `docs/modernization` of the legacy repository. */
  readonly modDirAbs: string
  /** Absolute legacy repository root, where program source paths resolve. */
  readonly workDir: string
  /** The Context budget in chars the judge prompt is capped to. */
  readonly limit: number
}

/**
 * Judging is resumable per program: the verdict persists under
 * `gate/<NAME>.json`, fingerprinted over the source, spec, feature, and
 * rubric it judged. Unchanged content reuses the stored verdict with NO
 * model call, so a crash or quota death re-judges only what changed.
 * Delete `gate/` to force a full re-judge. `extraRubric` (a deepen focus)
 * joins the rubric and therefore the fingerprint.
 */
export const makeProgramJudge = (deps: ProgramJudgeDeps) => {
  const { context, files, pack, modDirAbs, workDir, limit } = deps
  const packJudge = judge(context.reasoning, pack.judgeDimensions)

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
            .evaluate(Sample.make({ response, context: source_, query: context.userPrompt }))
            .pipe(Effect.mapError(FlowLlmError.from))
        }),
      { start: limit }
    ).pipe(Effect.provideService(FlowEvents, context.events))

  return (unit: ProgramUnit, extraRubric?: string): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const spec = (yield* files.read(join(modDirAbs, "specs", `${unit.name}.md`))) ?? ""
      const feature =
        (yield* files.read(join(modDirAbs, "features", `${unit.name.toLowerCase()}.feature`))) ?? ""
      const source = (yield* files.read(join(workDir, unit.sourcePath))) ?? ""
      const rubric = [
        ...pack.judgeDimensions.map(
          (dimension) => `${dimension.name} (0..${dimension.maxScore}): ${dimension.rubric}`
        ),
        ...(extraRubric === undefined ? [] : [extraRubric])
      ].join("\n")
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
}

/**
 * One bounded fix turn: the coder edits the pack against `ask`, then the
 * working tree is committed. A wedged agent that trips its turn limit
 * mid-fix still wrote something; the caller re-evaluates what landed.
 */
export const fixTurn = (
  context: FlowContextShape,
  system: string,
  ask: string,
  commitMessage: string
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const chat = yield* makeChat(context.coder, { system })
    yield* chat.ask(ask).pipe(
      Effect.asVoid,
      Effect.catchIf(
        (error) => error._tag === "Llm" && error.cause?._tag === "TurnLimitError",
        () =>
          context.events.publish(
            Info.make({
              message: "turn limit hit during a fix turn — re-evaluating what was written"
            })
          )
      )
    )
    yield* context.git.commitAll(commitMessage).pipe(Effect.asVoid)
  })
