import * as Effect from "effect/Effect"
import { runFlowMain } from "@llm4ts/runner/FlowRunner"
import { parseLoopArgs, runLoop } from "./Loop.ts"

const argv = process.argv.slice(2)
const parsed = parseLoopArgs(argv)

if (!parsed.ok) {
  process.stdout.write(`${parsed.error.message}\n`)
  process.exitCode = parsed.help ? 0 : 1
} else {
  runFlowMain(
    runLoop({ args: parsed.value, environment: process.env, workspace: process.cwd() }).pipe(
      Effect.catchTag("ScriptUsage", (usage) =>
        Effect.sync(() => {
          process.stderr.write(`${usage.message}\n`)
          process.exitCode = 1
        })
      )
    )
  )
}
