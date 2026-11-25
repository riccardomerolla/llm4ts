import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { bundleWorkflowCode } from "@temporalio/worker"
import * as Effect from "effect/Effect"

const workflowsPath = fileURLToPath(new URL("../src/Workflows.ts", import.meta.url))

describe("the workflow bundle", () => {
  // Bundling needs no server and no network: it proves the workflow file
  // loads into Temporal's sandbox, and that it does not drag `effect` or a
  // Node module in with it.
  it.live(
    "builds offline and holds the workflow without the Effect runtime",
    () =>
      Effect.gen(function* () {
        const { code } = yield* Effect.promise(() =>
          bundleWorkflowCode({
            workflowsPath,
            logger: {
              log: () => {},
              trace: () => {},
              debug: () => {},
              info: () => {},
              warn: () => {},
              error: () => {}
            }
          })
        )
        assert.include(code, "flowRun")
        assert.include(code, "WAIT_CANCELLATION_COMPLETED")
        assert.notInclude(code, "node_modules/effect/")
        assert.notInclude(code, "node:child_process")
      }),
    60_000
  )
})
