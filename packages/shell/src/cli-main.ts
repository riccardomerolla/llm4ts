#!/usr/bin/env node
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { runShellCommand } from "./Cli.ts"

const exitCodeFor = (error: unknown): number => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "ShellUsage":
      case "ShowHelp":
        return 2
      default:
        return 1
    }
  }
  return 1
}

const errorMessage = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "ShowHelp") {
      // Help (with any parse errors) was already rendered by the command runner.
      return undefined
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message
    }
  }
  return String(error)
}

Effect.runFork(
  runShellCommand(process.argv.slice(2)).pipe(
    Effect.match({
      onFailure: (error) =>
        Effect.sync(() => {
          const message = errorMessage(error)
          if (message !== undefined) {
            process.stderr.write(`llm4ts: ${message}\n`)
          }
          process.exitCode = exitCodeFor(error)
        }),
      onSuccess: () => Effect.void
    }),
    Effect.flatten,
    Effect.provide(NodeServices.layer)
  )
)
