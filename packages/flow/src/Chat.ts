import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Message, type LlmResponse } from "@llm4ts/core/Models"
import { collectAny } from "@llm4ts/core/Streaming"
import { withToolActivity } from "./Activity.ts"
import { FlowLlmError, type Stalled } from "./FlowError.ts"
import { noRepeats, stallGuard, type StallOptions } from "./Stall.ts"
import { Info, TokensUsed, type FlowEventsShape } from "./FlowEvents.ts"
import { isContextOverflow } from "./TransientRetry.ts"

export const gitOwnershipInstruction =
  "The flow runtime owns git operations. Do not create or switch branches, commit, push, or open pull requests."

export interface ChatOptions {
  readonly system?: string
  readonly manageGit?: boolean
  /**
   * When set, every reply whose collected response carries token usage is
   * published as a `TokensUsed` event, which is what `CostTracker` (and
   * therefore cost summaries and budgets) consume. Without it, usage
   * reported by the backend is silently discarded.
   */
  readonly events?: FlowEventsShape
  /** Request label for published `TokensUsed` events. Default: "chat". */
  readonly agent?: string
  /** End a turn that repeats one tool call or goes silent (ADR 0027 decision 11). */
  readonly stall?: StallOptions
}

const publishUsage = (options: ChatOptions, response: LlmResponse): Effect.Effect<void> =>
  options.events === undefined || response.usage === undefined
    ? Effect.void
    : options.events.publish(
        TokensUsed.make({
          agent: options.agent ?? "chat",
          usage: response.usage,
          ...(response.metadata.model === undefined ? {} : { model: response.metadata.model })
        })
      )

export interface Chat {
  readonly ask: (prompt: string) => Effect.Effect<string, FlowLlmError | Stalled>
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
  const repeats = yield* Ref.make(noRepeats)

  const send = (messages: ReadonlyArray<Message>) => {
    const stream = service.executeStreamWithHistory(messages)
    const watched = options.events === undefined ? stream : withToolActivity(options.events, stream)
    return collectAny(
      options.stall === undefined ? watched : stallGuard(watched, options.stall, repeats)
    )
  }

  const askRound = Effect.fn("@llm4ts/flow/Chat.ask")(function* (
    prompt: string
  ): Effect.fn.Return<string, FlowLlmError | Stalled> {
    const userTurn = Message.make({ role: "User", content: prompt })
    const earlier = yield* Ref.get(history)
    const full = [...earlier, userTurn]
    const system = earlier.filter((message) => message.role === "System")
    let messages = full
    // Every ask replays the whole conversation, so a long review loop can
    // outgrow the model's window. The earlier turns are the cheapest thing to
    // drop: a coding agent's work is in the working tree, not in the
    // transcript — so on overflow, retry once with the system prompt and
    // this turn alone, and continue the conversation from there.
    const response = yield* send(full).pipe(
      Effect.catchIf(
        (error) =>
          error._tag !== "Stalled" && isContextOverflow(error) && full.length > system.length + 1,
        (error) =>
          Effect.gen(function* () {
            messages = [
              ...system,
              Message.make({
                role: "User",
                content: [
                  "(Earlier turns of this conversation were dropped to fit the model's context",
                  "window. Your previous work is in the working tree: inspect it there.)",
                  "",
                  prompt
                ].join("\n")
              })
            ]
            if (options.events !== undefined) {
              yield* options.events.publish(
                Info.make({
                  message: `⚠ context: ${options.agent ?? "chat"} history did not fit (${error.message}); retrying with the current turn only`
                })
              )
            }
            return yield* send(messages)
          })
      ),
      Effect.mapError((error) => (error._tag === "Stalled" ? error : FlowLlmError.from(error)))
    )
    yield* publishUsage(options, response)
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
