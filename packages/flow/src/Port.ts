// Porting a code base file by file (ADR 0028): the manifest, its batches, the
// deterministic target path, the machine-readable PORT STATUS trailer every
// draft ends with, and the pilot report. Pure; the flows own the seats.
import { basename, dirname, extname } from "node:path"
import * as Schema from "effect/Schema"
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
