/**
 * The chief flow's logic: read one chat request's context, ask a toolless
 * seat for a proposal, validate it, and leave the action where the chat
 * loop reads it.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import {
  ChiefAction,
  ChiefContext,
  ChiefProposal,
  chiefPrompt,
  chiefProposalJsonSchema,
  failedReply,
  validateChiefProposal
} from "@llm4ts/flow/ChiefAction"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"

const ChiefContextJson = Schema.fromJsonString(ChiefContext)
const ChiefActionJson = Schema.fromJsonString(ChiefAction)

export const loadChiefContext = (
  files: PlainFileStoreShape,
  task: string
): Effect.Effect<ChiefContext, ScriptUsage> => {
  const path = task.trim()
  return Effect.gen(function* () {
    const text = yield* files.read(path)
    if (text === undefined) {
      return yield* ScriptUsage.make({ message: `no chief context at ${path}` })
    }
    return yield* Schema.decodeUnknownEffect(ChiefContextJson)(text)
  }).pipe(
    Effect.catchTag(["Persistence", "SchemaError"], (error) =>
      Effect.fail(
        ScriptUsage.make({ message: `could not read the chief context ${path}: ${error.message}` })
      )
    )
  )
}

const failed: ChiefAction = { _tag: "Failed", reply: failedReply }

export const runChief = (deps: {
  readonly files: PlainFileStoreShape
  readonly events: FlowEventsShape
  readonly seat: LlmServiceShape
  readonly context: ChiefContext
}): Effect.Effect<ChiefAction, PersistenceError> =>
  Effect.gen(function* () {
    const decide = Effect.gen(function* () {
      let violations: ReadonlyArray<string> = []
      for (let round = 1; round <= 2; round += 1) {
        const proposal = yield* structuredAndPublish(
          deps.seat,
          deps.events,
          chiefPrompt(deps.context, violations),
          ChiefProposal,
          chiefProposalJsonSchema,
          "chief"
        )
        const validation = validateChiefProposal(proposal, deps.context)
        if (validation._tag === "Valid") return validation.action
        violations = validation.violations
        yield* deps.events.publish(
          Info.make({ message: `chief: proposal ${round} invalid: ${violations.join(" ")}` })
        )
      }
      return failed
    })
    const action = yield* decide.pipe(
      Effect.catchTag("Llm", (error) =>
        deps.events
          .publish(Info.make({ message: `chief: the seat failed: ${error.message}` }))
          .pipe(Effect.as(failed))
      )
    )
    yield* deps.files.writeAtomic(
      deps.context.actionPath,
      Schema.encodeSync(ChiefActionJson)(action)
    )
    return action
  })
