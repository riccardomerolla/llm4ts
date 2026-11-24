import { join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  makeControlInbox,
  RetryStory,
  SkipStory,
  type ControlAction,
  type ControlCommand,
  type ControlInboxShape,
  type ControlReceipt
} from "@llm4ts/flow/Control"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { controlRoot } from "@llm4ts/runner/CheckoutState"
import { ShellUsageError } from "./ShellErrors.ts"

/**
 * The control inbox as a person and the operator server use it (ADR 0057):
 * `llm4ts inbox` and the `story_retry`, `story_skip` and `control_list` tools
 * call the same functions. Neither needs a server running: the log is a file.
 */

type Environment = Readonly<Record<string, string | undefined>>

/** A checkout's inbox on a file store. */
export const inboxOf = (
  files: PlainFileStoreShape,
  environment: Environment,
  repoPath: string
): ControlInboxShape => makeControlInbox({ files, root: controlRoot(environment, repoPath) })

/** One command as a listing shows it. */
export const ControlEntry = Schema.Struct({
  id: Schema.String,
  /** ISO time the command was written. */
  at: Schema.String,
  by: Schema.String,
  command: Schema.Literals(["retry", "skip"]),
  story: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  /** Absent while the command is pending. */
  outcome: Schema.optionalKey(Schema.Literals(["applied", "refused", "expired"])),
  /** Why it was refused. */
  refusal: Schema.optionalKey(Schema.String),
  /** The run that answered. */
  runId: Schema.optionalKey(Schema.String)
})
export type ControlEntry = typeof ControlEntry.Type

export const InboxListing = Schema.Struct({
  epic: Schema.String,
  pending: Schema.Array(ControlEntry),
  /** The last answered commands, newest first. */
  answered: Schema.Array(ControlEntry)
})
export type InboxListing = typeof InboxListing.Type

const entryOf = (command: ControlCommand, receipt?: ControlReceipt): ControlEntry => ({
  id: command.id,
  at: new Date(command.at).toISOString(),
  by: command.by,
  command: command.command._tag === "RetryStory" ? "retry" : "skip",
  story: command.command.story,
  ...(command.command._tag === "SkipStory" ? { reason: command.command.reason } : {}),
  ...(receipt === undefined ? {} : { outcome: receipt.outcome, runId: receipt.runId }),
  ...(receipt?.reason === undefined ? {} : { refusal: receipt.reason })
})

export const inboxListing = (
  inbox: ControlInboxShape,
  epic: string,
  last = 10
): Effect.Effect<InboxListing, PersistenceError> =>
  Effect.map(inbox.log(epic), ({ commands, receipts }) => ({
    epic,
    pending: commands.filter((command) => !receipts.has(command.id)).map((c) => entryOf(c)),
    answered: commands
      .filter((command) => receipts.has(command.id))
      .slice(-last)
      .reverse()
      .map((command) => entryOf(command, receipts.get(command.id)))
  }))

const lineOf = (entry: ControlEntry): string => {
  const what = `${entry.command} ${entry.story}${entry.reason === undefined ? "" : ` (${entry.reason})`}`
  const how =
    entry.outcome === undefined
      ? "pending"
      : `${entry.outcome}${entry.refusal === undefined ? "" : `: ${entry.refusal}`}`
  return `  ${entry.at}  ${what} — ${how}  [${entry.id}, by ${entry.by}]`
}

export const renderInboxListing = (listing: InboxListing): string =>
  [
    `epic ${listing.epic}`,
    listing.pending.length === 0
      ? "pending: none"
      : `pending (a live run applies them within two seconds; with none live, the next run expires them):`,
    ...listing.pending.map(lineOf),
    ...(listing.answered.length === 0 ? [] : ["answered, newest first:"]),
    ...listing.answered.map(lineOf)
  ].join("\n")

export const retryOf = (story: string): ControlAction => RetryStory.make({ story })
export const skipOf = (story: string, reason: string): ControlAction =>
  SkipStory.make({ story, reason })

/** The epics of a checkout, by the folders under `.llm4ts/epics/`. */
export const epicsOf = (
  listEpics: (directory: string) => ReadonlyArray<string>,
  repoPath: string
): ReadonlyArray<string> => listEpics(join(resolve(repoPath), ".llm4ts", "epics"))

/**
 * The epic a command line means: the one named, which must be a folder on
 * disk so no text becomes a path, or the only one the checkout has.
 */
export const epicFor = (
  epics: ReadonlyArray<string>,
  named: string | undefined
): Effect.Effect<string, ShellUsageError> => {
  if (named !== undefined) {
    return epics.includes(named)
      ? Effect.succeed(named)
      : Effect.fail(
          new ShellUsageError({
            message: `unknown epic '${named}'${epics.length === 0 ? ": this repository has none" : `; this repository has ${epics.join(", ")}`}`
          })
        )
  }
  const [only] = epics
  return only !== undefined && epics.length === 1
    ? Effect.succeed(only)
    : Effect.fail(
        new ShellUsageError({
          message:
            epics.length === 0
              ? "this repository has no epic under .llm4ts/epics/"
              : `--epic is needed: this repository has ${epics.join(", ")}`
        })
      )
}
