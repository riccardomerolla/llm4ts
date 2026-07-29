import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Message } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError } from "./FlowError.ts"

export const gitOwnershipInstruction =
  "The flow runtime owns git operations. Do not create or switch branches, commit, push, or open pull requests."

export interface ChatOptions {
  readonly system?: string
  readonly manageGit?: boolean
}

export interface Chat {
  readonly ask: (prompt: string) => Effect.Effect<string, FlowLlmError>
  readonly messages: Effect.Effect<ReadonlyArray<Message>>
}

const initialHistory = (options: ChatOptions): ReadonlyArray<Message> => {
  const system =
    options.manageGit === true
      ? options.system
      : [gitOwnershipInstruction, options.system]
          .filter((part) => part !== undefined && part.length > 0)
          .join("\n\n")
  return system === undefined || system.length === 0
    ? []
    : [Message.make({ role: "System", content: system })]
}

export const makeChat = Effect.fn("@llm4ts/flow/Chat.make")(function* (
  service: LlmServiceShape,
  options: ChatOptions = {}
): Effect.fn.Return<Chat> {
  const history = yield* Ref.make(initialHistory(options))
  const gate = yield* Semaphore.make(1)

  const askRound = Effect.fn("@llm4ts/flow/Chat.ask")(function* (
    prompt: string
  ): Effect.fn.Return<string, FlowLlmError> {
    const userTurn = Message.make({ role: "User", content: prompt })
    const messages = [...(yield* Ref.get(history)), userTurn]
    const response = yield* collect(service.executeStreamWithHistory(messages)).pipe(
      Effect.mapError(FlowLlmError.from)
    )
    yield* Ref.set(history, [
      ...messages,
      Message.make({ role: "Assistant", content: response.content })
    ])
    return response.content
  })

  return {
    ask: (prompt) => gate.withPermit(askRound(prompt)),
    messages: Ref.get(history)
  }
})
