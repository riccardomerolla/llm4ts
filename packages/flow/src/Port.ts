// Porting a code base file by file (ADR 0028): the manifest, its batches, the
// deterministic target path, the machine-readable PORT STATUS trailer every
// draft ends with, and the pilot report. Pure; the flows own the seats.
import { basename, dirname, extname } from "node:path"
import * as Schema from "effect/Schema"
import type { ReviewResult } from "./Review.ts"
import { DraftApprovalMarker } from "./Approval.ts"
import type { QueueOutcome } from "./WorkQueue.ts"

export class PortEntry extends Schema.Class<PortEntry>("PortEntry")({
  /** Repo-relative source path; also the queue item id. */
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  loc: Schema.Int
}) {}

/**
 * The target path of a source, from the pack's `target:` template:
 * `{{dir}}` (the source's directory, "" at the root), `{{base}}` (its name
 * without extension), `{{ext}}` (the extension without the dot), `{{path}}`
 * (the whole source path).
 */
export const targetPathOf = (template: string, source: string): string => {
  const dir = dirname(source)
  const ext = extname(source)
  const rendered = template
    .replaceAll("{{dir}}", dir === "." ? "" : dir)
    .replaceAll("{{base}}", basename(source, ext))
    .replaceAll("{{ext}}", ext.replace(/^\./u, ""))
    .replaceAll("{{path}}", source)
  return rendered.replace(/^\/+/u, "").replaceAll("//", "/")
}

export const linesOf = (text: string): number =>
  text.length === 0 ? 0 : text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length

export interface BatchPolicy {
  /** Files per batch. Default 100. */
  readonly files?: number
  /** A batch whose first file is longer than this (lines) shrinks to `small`. Default 2200. */
  readonly bigLoc?: number
  /** Default 6. */
  readonly small?: number
}

/** Contiguous batches of the manifest; a batch led by a big file is small (the Bun rule). */
export const batchesOf = (
  entries: ReadonlyArray<PortEntry>,
  policy: BatchPolicy = {}
): ReadonlyArray<ReadonlyArray<PortEntry>> => {
  const files = Math.max(1, policy.files ?? 100)
  const bigLoc = policy.bigLoc ?? 2_200
  const small = Math.max(1, policy.small ?? 6)
  const batches: Array<ReadonlyArray<PortEntry>> = []
  let index = 0
  while (index < entries.length) {
    const first = entries[index]
    const size = first !== undefined && first.loc > bigLoc ? small : files
    batches.push(entries.slice(index, index + size))
    index += size
  }
  return batches
}

export const PortConfidence = Schema.Literals(["high", "medium", "low"])
export type PortConfidence = typeof PortConfidence.Type

export interface PortStatus {
  readonly confidence: PortConfidence | undefined
  readonly todos: number | undefined
  readonly notes: string | undefined
}

const statusWindow = 40

/**
 * The PORT STATUS trailer of a draft: in any comment syntax, within the last
 * lines of the file, `confidence: high|medium|low`, `todos: <n>`, `notes: …`.
 * All undefined when the draft has no trailer.
 */
export const portStatusIn = (text: string): PortStatus => {
  const lines = text.split(/\r?\n/u)
  const tail = lines.slice(Math.max(0, lines.length - statusWindow))
  const start = tail.findIndex((line) => /PORT STATUS/u.test(line))
  if (start < 0) {
    return { confidence: undefined, todos: undefined, notes: undefined }
  }
  const block = tail.slice(start).join("\n")
  const confidence = /confidence:\s*(high|medium|low)\b/iu.exec(block)?.[1]?.toLowerCase()
  const todos = /todos?:\s*(\d+)/iu.exec(block)?.[1]
  const notes = /notes?:\s*(.+)$/imu.exec(block)?.[1]?.trim()
  return {
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : undefined,
    todos: todos === undefined ? undefined : Number.parseInt(todos, 10),
    notes: notes === undefined || notes.length === 0 ? undefined : notes.replace(/\s*\*\/\s*$/u, "")
  }
}

/** The instruction every implementer gets: how to end the file. */
export const portStatusInstruction = (comment: string): string =>
  [
    `End the file with a machine-readable trailer in ${comment} comments, exactly this shape:`,
    `${comment} PORT STATUS`,
    `${comment} source: <the source path>`,
    `${comment} confidence: high | medium | low`,
    `${comment} todos: <number of TODO(port) markers you left>`,
    `${comment} notes: <one line: what you could not translate faithfully, or "none">`,
    "`confidence: low` means the logic is probably wrong and must be re-read against the source."
  ].join("\n")

export interface PilotFacts {
  readonly outcomes: ReadonlyArray<QueueOutcome>
  readonly piloted: number
  readonly remaining: number
  readonly elapsedMs: number
  readonly estimatedCostUsd: number | undefined
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`

/** The pilot report (R7 of the plan): rates measured, totals extrapolated, an approval to continue. */
export const renderPilotReport = (facts: PilotFacts): string => {
  const done = facts.outcomes.filter((outcome) => outcome.status === "done")
  const failed = facts.outcomes.filter((outcome) => outcome.status === "failed")
  const count = (level: PortConfidence) =>
    done.filter((outcome) => outcome.confidence === level).length
  const todos = done.reduce((sum, outcome) => sum + (outcome.todos ?? 0), 0)
  const perItemMs = facts.piloted === 0 ? 0 : facts.elapsedMs / facts.piloted
  const perItemCost =
    facts.estimatedCostUsd === undefined || facts.piloted === 0
      ? undefined
      : facts.estimatedCostUsd / facts.piloted
  return [
    "# Port pilot",
    "",
    `- piloted: ${facts.piloted} file(s), ${done.length} done, ${failed.length} failed, in ${minutes(facts.elapsedMs)}`,
    `- confidence: ${count("high")} high, ${count("medium")} medium, ${count("low")} low; ${todos} TODO(port) marker(s)`,
    ...(perItemCost === undefined
      ? []
      : [
          `- cost: ~$${(facts.estimatedCostUsd ?? 0).toFixed(2)} (~$${perItemCost.toFixed(3)} per file)`
        ]),
    `- remaining: ${facts.remaining} file(s) → about ${minutes(perItemMs * facts.remaining)} at this rate${
      perItemCost === undefined ? "" : ` and ~$${(perItemCost * facts.remaining).toFixed(2)}`
    }`,
    "",
    ...(failed.length === 0
      ? []
      : [
          "## Failed",
          "",
          ...failed.map((outcome) => `- ${outcome.id}: ${outcome.note ?? ""}`),
          ""
        ]),
    "Read the drafted files beside their sources, then tick the box to let the next run",
    "port the rest; edit `prompts/porting.md` in the pack first if the drafts show a",
    "pattern the rulebook should settle.",
    "",
    DraftApprovalMarker,
    ""
  ].join("\n")
}

/** A whole new file rendered as a unified diff of additions, for reviewers that judge diffs. */
export const asAddedFileDiff = (path: string, content: string): string => {
  const lines = content.split(/\r?\n/u)
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n")
}

// ---- Ledger (port-ledger) --------------------------------------------------------------

/** One classified unit of a source file, with the line that proves it. */
export class LedgerRow extends Schema.Class<LedgerRow>("LedgerRow")({
  file: Schema.String,
  unit: Schema.String,
  class: Schema.String,
  /** `file:line` of the statement the classification rests on. */
  evidence: Schema.String,
  confidence: PortConfidence
}) {}

const tsvEscape = (value: string): string => value.replaceAll("\t", " ").replaceAll("\n", " ")

/** The ledger as a TSV with a header: `file unit class evidence confidence`. */
export const renderLedger = (rows: ReadonlyArray<LedgerRow>): string =>
  [
    "file\tunit\tclass\tevidence\tconfidence",
    ...rows.map((row) =>
      [row.file, row.unit, row.class, row.evidence, row.confidence].map(tsvEscape).join("\t")
    )
  ].join("\n") + "\n"

export const parseLedger = (text: string): ReadonlyArray<LedgerRow> =>
  text
    .split(/\r?\n/u)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const [file, unit, klass, evidence, confidence] = line.split("\t")
      return file === undefined || unit === undefined || klass === undefined
        ? []
        : [
            LedgerRow.make({
              file,
              unit,
              class: klass,
              evidence: evidence ?? "",
              confidence:
                confidence === "high" || confidence === "medium" || confidence === "low"
                  ? confidence
                  : "low"
            })
          ]
    })

/** The rows of one source file, rendered for its implementer ("trust the table over local guessing"). */
export const ledgerRowsFor = (rows: ReadonlyArray<LedgerRow>, file: string): string | undefined => {
  const mine = rows.filter((row) => row.file === file)
  return mine.length === 0
    ? undefined
    : mine
        .map((row) => `- ${row.unit}: ${row.class} (${row.evidence}; ${row.confidence})`)
        .join("\n")
}

/** The units a pack's `## Ledger` regex names in a source file, each once. */
export const unitsIn = (text: string, unitRegex: string): ReadonlyArray<string> => {
  const pattern = new RegExp(unitRegex, "gmu")
  const units: Array<string> = []
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const name = match.slice(1).find((group) => group !== undefined && group.length > 0)
    if (name !== undefined && !units.includes(name)) units.push(name)
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return units
}

// ---- Refutes (port-guide, port-ledger) ----------------------------------------------------

/** A claim stands unless a majority of its refuters reject it (the Bun port's 3-vote refute). */
export const standsAfterRefutes = (votes: ReadonlyArray<boolean>): boolean => {
  const rejected = votes.filter((holds) => !holds).length
  return votes.length === 0 ? true : rejected * 2 < votes.length
}

// ---- Guide audit (port-guide) -------------------------------------------------------------

export class GuideFinding extends Schema.Class<GuideFinding>("GuideFinding")({
  dimension: Schema.String,
  finding: Schema.String,
  /** A rulebook line, a sample source line, or a draft line that shows it. */
  evidence: Schema.String,
  /** The rule the rulebook should gain or change, one line. */
  proposedRule: Schema.String
}) {}

export const defaultAuditDimensions: ReadonlyArray<string> = [
  "error model",
  "ownership and memory",
  "collections and strings",
  "control flow and compile-time constructs",
  "API shape and naming",
  "concurrency and resources",
  "build, test and tooling idioms",
  "what not to translate"
]

export const renderGuideAudit = (facts: {
  readonly pack: string
  readonly kept: ReadonlyArray<GuideFinding>
  readonly dropped: ReadonlyArray<GuideFinding>
  readonly trial: ReadonlyArray<string>
  readonly sample: ReadonlyArray<string>
}): string =>
  [
    `# Rulebook audit — pack ${facts.pack}`,
    "",
    `- sample files: ${facts.sample.join(", ") || "none"}`,
    `- findings kept after the refute: ${facts.kept.length}; dropped: ${facts.dropped.length}`,
    "",
    ...(facts.kept.length === 0
      ? ["No finding survived: the rulebook stands as written.", ""]
      : [
          "## Proposed rules",
          "",
          "Each is an `append-rule` to `prompts/porting.md`, applied on the next run once approved.",
          "",
          ...facts.kept.flatMap((finding) => [
            `### ${finding.dimension}`,
            "",
            `**Finding.** ${finding.finding.trim()}`,
            "",
            `**Evidence.** ${finding.evidence.trim()}`,
            "",
            "```diff",
            `+ - ${finding.proposedRule.trim()}`,
            "```",
            ""
          ])
        ]),
    ...(facts.trial.length === 0
      ? []
      : [
          "## Trial port: where the native port and the rulebook port differ",
          "",
          ...facts.trial.map((line) => `- ${line}`),
          ""
        ]),
    ...(facts.dropped.length === 0
      ? []
      : [
          "## Dropped by the refute",
          "",
          ...facts.dropped.map((finding) => `- ${finding.dimension}: ${finding.finding.trim()}`),
          ""
        ]),
    DraftApprovalMarker,
    ""
  ].join("\n")

// ---- Differential (port-tests) ------------------------------------------------------------

export const DiffClass = Schema.Literals(["pass", "diverge", "crash", "hang", "legacy-red"])
export type DiffClass = typeof DiffClass.Type

export class DiffVerdict extends Schema.Class<DiffVerdict>("DiffVerdict")({
  file: Schema.String,
  class: DiffClass,
  legacyPassed: Schema.optionalKey(Schema.Int),
  targetPassed: Schema.optionalKey(Schema.Int),
  detail: Schema.String
}) {}

/**
 * The Bun test swarm's verdict: a test file passes when the target exits 0
 * AND its pass count equals the legacy baseline's (when both are known). A
 * legacy run that is red itself is no evidence about the target.
 */
export const diffVerdict = (
  file: string,
  legacy: ReviewResult,
  target: ReviewResult,
  roots: ReadonlyArray<string> = []
): DiffVerdict => {
  const strip = (text: string): string =>
    roots.reduce((acc, root) => acc.replaceAll(`${root}/`, ""), text)
  const legacyPassed = legacy.passed
  const targetPassed = target.passed
  const counts = {
    ...(legacyPassed === undefined ? {} : { legacyPassed }),
    ...(targetPassed === undefined ? {} : { targetPassed })
  }
  if (!legacy.isClean) {
    return DiffVerdict.make({
      file,
      class: "legacy-red",
      ...counts,
      detail: "the legacy build fails this file too; nothing to compare"
    })
  }
  const gate = target.issues.find((issue) => issue.gateClass !== undefined)
  if (gate?.gateClass === "hang") {
    return DiffVerdict.make({ file, class: "hang", ...counts, detail: strip(gate.description) })
  }
  if (gate?.gateClass === "crash") {
    return DiffVerdict.make({ file, class: "crash", ...counts, detail: strip(gate.description) })
  }
  if (!target.isClean) {
    return DiffVerdict.make({
      file,
      class: "diverge",
      ...counts,
      detail: strip(target.issues.map((issue) => issue.description).join("\n"))
    })
  }
  if (legacyPassed !== undefined && targetPassed !== undefined && targetPassed !== legacyPassed) {
    return DiffVerdict.make({
      file,
      class: "diverge",
      ...counts,
      detail: `${targetPassed} test(s) pass on the target, ${legacyPassed} on the legacy build`
    })
  }
  return DiffVerdict.make({ file, class: "pass", ...counts, detail: "" })
}

/** The `.diag` a fixer reads as its only runtime evidence. */
export const renderDiag = (verdict: DiffVerdict, tailChars = 4_000): string =>
  [
    `# ${verdict.file}: ${verdict.class}`,
    "",
    `- legacy passed: ${verdict.legacyPassed ?? "unknown"}; target passed: ${verdict.targetPassed ?? "unknown"}`,
    "",
    "## Target output (tail)",
    "",
    "```",
    verdict.detail.length > tailChars ? `…${verdict.detail.slice(-tailChars)}` : verdict.detail,
    "```",
    ""
  ].join("\n")

export const renderDifferentialReport = (
  round: number,
  verdicts: ReadonlyArray<DiffVerdict>
): string => {
  const by = (klass: DiffClass) => verdicts.filter((verdict) => verdict.class === klass)
  return [
    `# Differential tests, round ${round}`,
    "",
    `- files: ${verdicts.length}; pass ${by("pass").length}, diverge ${by("diverge").length}, crash ${by("crash").length}, hang ${by("hang").length}, legacy-red ${by("legacy-red").length}`,
    "",
    ...(["diverge", "crash", "hang"] as const).flatMap((klass) =>
      by(klass).length === 0
        ? []
        : [`## ${klass}`, "", ...by(klass).map((verdict) => `- ${verdict.file}`), ""]
    )
  ].join("\n")
}
