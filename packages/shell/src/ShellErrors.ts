import * as Schema from "effect/Schema"

/** Shared so modules that `Cli.ts` imports can fail with it without an import cycle. */
export class ShellUsageError extends Schema.TaggedError<ShellUsageError>()("ShellUsage", {
  message: Schema.String
}) {}
