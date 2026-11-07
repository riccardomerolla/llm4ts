// Evidence, not assertion (ADR 0027, decision 6): what a task's reply claims
// to have verified, checked against the commands the transcript shows it
// ran. Pure; the story executor supplies the tool calls.
import { ReviewIssue } from "./Review.ts"

export const fabricatedStatusPrefix = "fabricated status: "

const normalizeCommand = (command: string): string =>
  command
    .trim()
    .replace(/^[`'"]+|[`'"]+$/gu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase()

/**
 * The commands a reply claims to have run that no tool call in the task
 * carried. A claim is carried when any tool call's arguments contain it,
 * whitespace and quoting aside; a claim that is a prefix of a longer
 * invocation (`pnpm test` within `pnpm test -- --run x`) counts as carried.
 */
export const unverifiedClaims = (
  claimed: ReadonlyArray<string>,
  toolArgs: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const ran = toolArgs.map(recordedCommand)
  return claimed.filter((claim) => {
    const wanted = normalizeCommand(claim)
    return wanted.length > 0 && !ran.some((args) => carries(args, wanted))
  })
}

interface RecordedCommand {
  readonly text: string
  /** The transcript keeps a command's first characters and an ellipsis. */
  readonly truncated: boolean
}

const recordedCommand = (args: string): RecordedCommand => {
  const trimmed = args.trimEnd()
  const truncated = trimmed.endsWith("…")
  return { text: normalizeCommand(truncated ? trimmed.slice(0, -1) : trimmed), truncated }
}

/** The shortest head of a cut command that still identifies it. */
const minimumHead = 24

/**
 * A recorded call carries a claim when it contains it; a call the transcript
 * cut short carries a longer claim when the cut's last command segment (after
 * `;`, `&&` or `|`) is the start of the claim — `llm4ts tool validate-account
 * --document fixtures/… ` recorded as its first 120 characters still proves
 * the full invocation the coder quotes (ADR 0048).
 */
const carries = (args: RecordedCommand, wanted: string): boolean => {
  if (args.text.includes(wanted)) {
    return true
  }
  if (!args.truncated) {
    return false
  }
  const head = args.text.split(/\s*(?:;|&&|\|\|?)\s*/u).at(-1) ?? ""
  return head.length >= minimumHead && wanted.startsWith(head)
}

/** One Warning per claimed-but-unrun command, for the story's findings and the judge. */
export const fabricatedStatusIssues = (
  unverified: ReadonlyArray<string>
): ReadonlyArray<ReviewIssue> =>
  unverified.map((command) =>
    ReviewIssue.make({
      severity: "Warning",
      title: `${fabricatedStatusPrefix}claimed \`${command}\` but no tool call ran it`,
      description:
        "The coder's Findings say this command verified the task; the transcript shows no such call. Treat the task's own account of its testing as unreliable."
    })
  )
