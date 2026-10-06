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
  const ran = toolArgs.map(normalizeCommand)
  return claimed.filter((claim) => {
    const wanted = normalizeCommand(claim)
    return wanted.length > 0 && !ran.some((args) => args.includes(wanted))
  })
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
