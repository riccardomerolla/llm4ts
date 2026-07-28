#!/usr/bin/env node
import * as Effect from "effect/Effect"
import { makeCliProgram } from "./Cli.ts"

const main = makeCliProgram(process.argv.slice(2)).pipe(
  Effect.match({
    onFailure: (error) => {
      process.stderr.write(`${error.message}\n`)
      return error._tag === "ScriptUsage" ? 2 : 1
    },
    onSuccess: () => 0
  }),
  Effect.flatMap((exitCode) =>
    Effect.sync(() => {
      process.exitCode = exitCode
    })
  )
)

Effect.runFork(main)
