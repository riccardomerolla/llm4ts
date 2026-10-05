// What a story's earlier tasks learned, carried into the next task's prompt.
// With one chat per task (ADR 0003) every task starts cold; without this a
// six-task story explores the repository six times. The coder ends each task
// with a short Findings section; code saves it beside the story and prepends
// the accumulated notes to the next task. Pure helpers here, the seam in Flow.
import type * as Effect from "effect/Effect"
import type { FlowError } from "./FlowError.ts"

export const notesHeading = "## Findings"

/** Appended to every task prompt that carries notes. */
export const findingsRequest = [
  "",
  `When the task is done, end your reply with a section headed \`${notesHeading}\` of at most`,
  "ten lines: files you read or changed that matter for the rest of this story, conventions",
  "you learned (where tests live, how a feature is registered, which kit component to use),",
  "and commands that worked. Nothing follows it — unless you must stop with BLOCKED_ON:,",
  "which stays the last line."
].join("\n")

const sectionChars = 1_500
const headingPattern = /^#{1,3}[ \t]*findings[ \t]*:?[ \t]*$/gimu
const blockedLine = /^BLOCKED_ON:.*$/u

/**
 * The text after the LAST Findings heading, without a trailing BLOCKED_ON
 * line (that stays the reply's last line for `blockedOnIn`), capped;
 * undefined when there is no heading or nothing under it.
 */
export const findingsIn = (reply: string): string | undefined => {
  let last: RegExpExecArray | undefined
  headingPattern.lastIndex = 0
  for (let match = headingPattern.exec(reply); match !== null; match = headingPattern.exec(reply)) {
    last = match
  }
  if (last === undefined) {
    return undefined
  }
  const lines = reply
    .slice(last.index + last[0].length)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
  while (lines.length > 0 && (lines.at(-1) ?? "").trim().length === 0) {
    lines.pop()
  }
  if (
    lines.length > 0 &&
    blockedLine.test((lines.at(-1) ?? "").trim().replace(/^[`*_\s]+|[`*_\s]+$/gu, ""))
  ) {
    lines.pop()
  }
  const text = lines.join("\n").trim()
  return text.length === 0 ? undefined : text.slice(0, sectionChars)
}

export const notesLimit = 6_000

/**
 * `notes` plus a titled section for `found`; when the result is over `limit`
 * the oldest sections go first, the newest always stays.
 */
export const appendNote = (
  notes: string | undefined,
  title: string,
  found: string,
  limit = notesLimit
): string => {
  const sections = [
    ...(notes === undefined || notes.trim().length === 0 ? [] : notes.split(/\n\n(?=### )/u)),
    `### ${title}\n${found.trim()}`
  ]
  while (sections.length > 1 && sections.join("\n\n").length > limit) {
    sections.shift()
  }
  return sections.join("\n\n")
}

/** The prompt with the notes in front, or the prompt itself when there are none. */
export const withNotes = (prompt: string, notes: string | undefined): string =>
  notes === undefined || notes.trim().length === 0
    ? prompt
    : [
        "What earlier tasks of this story learned — trust it before exploring:",
        "",
        notes.trim(),
        "",
        "---",
        "",
        prompt
      ].join("\n")

/** Where a story keeps its carried notes: read before a task, written after it. */
export interface CarriedNotes {
  readonly read: Effect.Effect<string | undefined, FlowError>
  readonly write: (notes: string) => Effect.Effect<void, FlowError>
}
