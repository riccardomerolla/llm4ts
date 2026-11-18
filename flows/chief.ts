// One chat request → the Chief of Staff's typed decision, written as JSON for the chat loop.
//
//   llm4ts run chief --repo ~/demo/portal -- <path to a ChiefContext JSON file>
//
// The chat loop starts this flow once per request through the run
// supervisor. The task is the path to the request's context (the request,
// the flows it may start, the runs it may stop, recent messages); one
// toolless seat (LLM4TS_REASONER) proposes an answer, a run to start or
// stop, or a decline. Code validates the proposal, asks once more with the
// violations when it is invalid, and writes the action to the context's
// actionPath: Failed, with a fixed reply, after a second invalid proposal or
// a seat failure. The seat's harness must enforce read-only, since a harness
// that only advises it may ignore the toolless request too. Nothing in the
// repository is touched.
import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import {
  ScriptUsage,
  asToolless,
  nodePlainFileStore,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"
import { readOnlySeatProblem, reasonerFromEnvironment } from "@llm4ts/runner/Connectors"
import { loadChiefContext, runChief } from "./lib/chief.ts"

const program = Effect.gen(function* () {
  const given = yield* resolveFlowInput()
  const files = nodePlainFileStore
  const context = yield* loadChiefContext(files, resolve(given.workspace, given.prompt.trim()))
  const reasoning = asToolless(yield* reasonerFromEnvironment())
  const problem = readOnlySeatProblem(reasoning)
  if (problem !== undefined) {
    return yield* ScriptUsage.make({ message: `chief: ${problem}` })
  }
  yield* runNode(
    {
      workDir: given.workDir,
      workspace: given.workspace,
      userPrompt: `chief decision for ${context.messageName}`,
      // No coder turn is ever taken: the toolless reasoning seat fills both.
      coder: reasoning,
      reasoning,
      environment: process.env
    },
    (flow) => runChief({ files, events: flow.events, seat: flow.reasoning, context })
  )
})

runFlowMain(program)
