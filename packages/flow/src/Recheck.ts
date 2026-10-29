/**
 * Incremental re-review (ADR 0044): what each reviewer found last time, which
 * files a fix touched, and so which reviewers a round asks again — in full,
 * or as a re-check of their own findings. Pure; the review loop owns the
 * calls and the persistence.
 */
import * as Schema from "effect/Schema"
import { fingerprintOf } from "./ReviewCache.ts"
import { ReviewIssue, ReviewResult, reviewPrompt } from "./ReviewModel.ts"

const fileHeader = /^diff --git a\/(.+?) b\/(.+)$/u

/** Each file of a unified diff, keyed by its new path, to a fingerprint of its section. */
export const diffChunks = (diff: string): Readonly<Record<string, string>> => {
  const sections = new Map<string, Array<string>>()
  let current: Array<string> | undefined
  for (const line of diff.split(/\r?\n/u)) {
    const header = fileHeader.exec(line)
    if (header !== null) {
      current = []
      sections.set(header[2] ?? header[1] ?? "", current)
    }
    current?.push(line)
  }
  return Object.fromEntries(
    Array.from(sections, ([path, lines]) => [path, fingerprintOf(lines)] as const)
  )
}

/** The files whose section was added, removed or changed between two `diffChunks`. */
export const touchedFiles = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): ReadonlyArray<string> =>
  Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((path) => before[path] !== after[path])
    .sort()

export const ReviewerState = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["clean", "dirty"]),
  findings: Schema.Array(ReviewIssue),
  /** Every changed file the reviewer has been shown so far. */
  seen: Schema.Array(Schema.String)
})
export type ReviewerState = typeof ReviewerState.Type

/** What a review loop remembers between rounds, and across a restart. */
export class ReviewMemory extends Schema.Class<ReviewMemory>("ReviewMemory")({
  version: Schema.Literal(1),
  /** The last round in which reviewers ran. */
  round: Schema.Int,
  /** `diffChunks` of the diff they reviewed. */
  chunks: Schema.Record(Schema.String, Schema.String),
  reviewers: Schema.Array(ReviewerState),
  /** The fix for this round's findings landed: a restart reviews the next round, not fixes first. */
  fixed: Schema.optionalKey(Schema.Boolean)
}) {}

/** A reviewer the round may ask: a lens, or an extra review such as the story judge. */
export interface Candidate {
  readonly name: string
  readonly matches: (files: ReadonlyArray<string>) => boolean
  /** Once clean, never asked again (the judge): it reruns only to re-check its findings. */
  readonly onlyWhenDirty?: boolean
}

export interface RoundPlan {
  readonly full: ReadonlyArray<string>
  readonly recheck: ReadonlyArray<string>
}

/**
 * Who a round asks: a candidate with no state reviews in full when it
 * matches the change; a dirty one re-checks its findings; a clean one reviews
 * in full only when the fix touched files it matches and has never seen.
 */
export const planRound = (
  candidates: ReadonlyArray<Candidate>,
  memory: ReviewMemory | undefined,
  changedFiles: ReadonlyArray<string>,
  touched: ReadonlyArray<string>
): RoundPlan => {
  const full: Array<string> = []
  const recheck: Array<string> = []
  for (const candidate of candidates) {
    const state = memory?.reviewers.find((entry) => entry.name === candidate.name)
    if (state === undefined) {
      if (candidate.matches(changedFiles)) full.push(candidate.name)
    } else if (state.status === "dirty") {
      recheck.push(candidate.name)
    } else if (candidate.onlyWhenDirty !== true) {
      const unseen = touched.filter((file) => !state.seen.includes(file))
      if (unseen.length > 0 && candidate.matches(unseen)) full.push(candidate.name)
    }
  }
  return { full, recheck }
}

/** The memory after a round: who ran takes this round's answer, everyone else keeps theirs. */
export const remember = (
  memory: ReviewMemory | undefined,
  round: number,
  chunks: Readonly<Record<string, string>>,
  ran: ReadonlyArray<{ readonly name: string; readonly result: ReviewResult }>,
  files: ReadonlyArray<string>
): ReviewMemory => {
  const kept = memory?.reviewers ?? []
  const updated = (name: string, result: ReviewResult): ReviewerState => {
    const before = kept.find((entry) => entry.name === name)
    return {
      name,
      status: result.isClean ? "clean" : "dirty",
      findings: result.issues,
      seen: Array.from(new Set([...(before?.seen ?? []), ...files]))
    }
  }
  const reviewers = kept.map((entry) => {
    const answer = ran.find((item) => item.name === entry.name)
    return answer === undefined ? entry : updated(entry.name, answer.result)
  })
  for (const answer of ran) {
    if (!kept.some((entry) => entry.name === answer.name)) {
      reviewers.push(updated(answer.name, answer.result))
    }
  }
  return ReviewMemory.make({ version: 1, round, chunks, reviewers })
}

/** The findings still standing: every dirty reviewer's last answer. */
export const standing = (memory: ReviewMemory): ReviewResult =>
  ReviewResult.make({
    issues: memory.reviewers.flatMap((entry) => (entry.status === "dirty" ? entry.findings : []))
  })

/** What a re-check asks, before the review prompt's JSON contract and the diff. */
export const recheckLead = (
  title: string,
  touched: ReadonlyArray<string>,
  prior: ReadonlyArray<ReviewIssue>
): string =>
  [
    `This is a re-check of a change you reviewed before, for "${title}".`,
    `Your earlier findings are listed below. The fix since then touched: ${touched.join(", ") || "no files"}.`,
    "For each earlier finding, report it again only if it is still present.",
    "Report a new problem only if the fix itself introduced it. Do not review the rest of the change afresh.",
    "Earlier findings:",
    ...prior.map(
      (finding) =>
        `- [${finding.severity}] ${finding.title}${finding.description.length > 0 ? `: ${finding.description}` : ""}`
    )
  ].join("\n")

/** A whole re-check prompt: the lead, then the review contract and the diff. */
export const recheckPrompt = (
  title: string,
  diff: string,
  touched: ReadonlyArray<string>,
  prior: ReadonlyArray<ReviewIssue>
): string => `${recheckLead(title, touched, prior)}\n\n${reviewPrompt(title, diff)}`
