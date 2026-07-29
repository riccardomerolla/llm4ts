#!/usr/bin/env node
import { readFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import { makeCliProgram } from "./Cli.ts"
import { makeDoctorProgram } from "./Doctor.ts"
import { FlowHelp, parseFlowArgs } from "./FlowArgs.ts"

const argv = process.argv.slice(2)

const packageVersion = (): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  )
  return typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
    ? manifest.version
    : "unknown"
}

const flowProgram = (): Effect.Effect<void> => {
  const parsed = parseFlowArgs(argv)
  if (parsed.ok && parsed.value.help === true) {
    return Effect.sync(() => process.stdout.write(FlowHelp))
  }
  if (parsed.ok && parsed.value.version === true) {
    return Effect.sync(() => process.stdout.write(`${packageVersion()}\n`))
  }
  return makeCliProgram(argv).pipe(
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
}

const main =
  argv[0] === "doctor"
    ? makeDoctorProgram().pipe(
        Effect.flatMap((report) => Effect.sync(() => process.stdout.write(report)))
      )
    : flowProgram()

Effect.runFork(main)
