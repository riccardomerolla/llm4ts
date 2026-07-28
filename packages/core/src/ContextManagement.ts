import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ConversationMessage, type PromptRole } from "./Conversation.ts"
import type { LlmProvider } from "./Models.ts"

export class ContextInvalidInput extends Schema.TaggedErrorClass<ContextInvalidInput>()(
  "InvalidInput",
  {
    message: Schema.String
  }
) {}

export class ContextParseFailed extends Schema.TaggedErrorClass<ContextParseFailed>()(
  "ParseFailed",
  {
    message: Schema.String
  }
) {}

export class ContextSummarizationFailed extends Schema.TaggedErrorClass<ContextSummarizationFailed>()(
  "SummarizationFailed",
  {
    message: Schema.String
  }
) {}

export class ContextToolLoopFailed extends Schema.TaggedErrorClass<ContextToolLoopFailed>()(
  "ToolLoopFailed",
  {
    message: Schema.String
  }
) {}

export const ContextError = Schema.Union([
  ContextInvalidInput,
  ContextParseFailed,
  ContextSummarizationFailed,
  ContextToolLoopFailed
])
export type ContextError = typeof ContextError.Type

export class ContextLimits extends Schema.Class<ContextLimits>("ContextLimits")({
  maxTokens: Schema.Int,
  warningThresholdPct: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(0.85)))
}) {}

export class ContextWindow extends Schema.Class<ContextWindow>("ContextWindow")({
  messages: Schema.Array(ConversationMessage),
  totalTokens: Schema.Int,
  approachingLimit: Schema.Boolean,
  trimmed: Schema.Boolean
}) {}

export class DropOldestFifo extends Schema.TaggedClass<DropOldestFifo>()("DropOldestFifo", {}) {}

export class SlidingWindow extends Schema.TaggedClass<SlidingWindow>()("SlidingWindow", {}) {}

export class PriorityBased extends Schema.TaggedClass<PriorityBased>()("PriorityBased", {}) {}

export class SummarizeOldMessages extends Schema.TaggedClass<SummarizeOldMessages>()(
  "SummarizeOldMessages",
  {
    summaryTargetTokens: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(256)))
  }
) {}

export const ContextTrimmingStrategy = Schema.Union([
  DropOldestFifo,
  SlidingWindow,
  PriorityBased,
  SummarizeOldMessages
])
export type ContextTrimmingStrategy = typeof ContextTrimmingStrategy.Type

export const ContextTrimmingStrategies = Object.freeze({
  DropOldestFifo: DropOldestFifo.make({}),
  SlidingWindow: SlidingWindow.make({}),
  PriorityBased: PriorityBased.make({}),
  SummarizeOldMessages: (summaryTargetTokens = 256): SummarizeOldMessages =>
    SummarizeOldMessages.make({ summaryTargetTokens })
})

export interface TokenCounter {
  readonly countText: (provider: LlmProvider, text: string) => number
  readonly countMessage: (provider: LlmProvider, message: ConversationMessage) => number
  readonly countMessages: (provider: LlmProvider, messages: Iterable<ConversationMessage>) => number
}

const roleOverhead = (role: PromptRole): number => {
  switch (role) {
    case "System":
      return 6
    case "User":
    case "Assistant":
      return 5
    case "Tool":
      return 8
  }
}

const providerCharactersPerToken = (provider: LlmProvider): number => {
  switch (provider) {
    case "OpenAI":
    case "OpenCode":
      return 4
    case "Anthropic":
      return 3.8
    case "GeminiApi":
    case "GeminiCli":
      return 4.2
    case "LmStudio":
    case "Ollama":
    case "Mock":
      return 4.5
  }
}

const countText = (provider: LlmProvider, text: string): number =>
  Math.max(1, Math.ceil(Math.max(text.length, 1) / providerCharactersPerToken(provider)))

const countMessage = (provider: LlmProvider, message: ConversationMessage): number =>
  countText(provider, message.content) + roleOverhead(message.role)

export const defaultTokenCounter: TokenCounter = {
  countText,
  countMessage,
  countMessages: (provider, messages) =>
    Array.from(messages).reduce((total, message) => total + countMessage(provider, message), 0)
}

export interface MessageSummarizer<R = never> {
  readonly summarize: (
    messages: ReadonlyArray<ConversationMessage>,
    targetTokens: number
  ) => Effect.Effect<ConversationMessage, ContextError, R>
}

export const simpleMessageSummarizer: MessageSummarizer<Crypto.Crypto> = {
  summarize: (messages, targetTokens) => {
    if (messages.length === 0) {
      return Effect.fail(
        ContextInvalidInput.make({
          message: "Cannot summarize empty messages"
        })
      )
    }

    const summaryText = messages
      .slice(0, 8)
      .map((message) => `${message.role.toLowerCase()}: ${message.content.slice(0, 160)}`)
      .join("\n")

    return Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((error) =>
          ContextSummarizationFailed.make({
            message: `Failed to generate summary id: ${error.message}`
          })
        )
      )
      const timestamp = yield* DateTime.now

      return ConversationMessage.make({
        id,
        role: "Assistant",
        content: `Summary of previous context:\n${summaryText}`,
        timestamp,
        tokens: Math.max(1, targetTokens),
        metadata: { summary: "true" },
        important: true
      })
    })
  }
}

const annotateTokens = (
  messages: ReadonlyArray<ConversationMessage>,
  provider: LlmProvider,
  tokenCounter: TokenCounter
): ReadonlyArray<ConversationMessage> =>
  messages.map((message) =>
    message.tokens > 0
      ? message
      : ConversationMessage.make({
          ...message,
          tokens: tokenCounter.countMessage(provider, message)
        })
  )

const dropOldest = (
  messages: ReadonlyArray<ConversationMessage>,
  maxTokens: number
): ReadonlyArray<ConversationMessage> => {
  let used = 0
  let kept: ReadonlyArray<ConversationMessage> = []

  for (const message of Array.from(messages).reverse()) {
    if (used + message.tokens <= maxTokens) {
      used += message.tokens
      kept = [message, ...kept]
    }
  }

  return kept
}

const slidingWindow = (
  messages: ReadonlyArray<ConversationMessage>,
  maxTokens: number
): ReadonlyArray<ConversationMessage> => {
  const system = messages.filter((message) => message.role === "System")
  const recentNonSystem = messages.filter((message) => message.role !== "System")
  const systemTokens = system.reduce((total, message) => total + message.tokens, 0)
  const tail = dropOldest(recentNonSystem, Math.max(0, maxTokens - systemTokens))
  return [...system, ...tail].slice(-messages.length)
}

const priorityWindow = (
  messages: ReadonlyArray<ConversationMessage>,
  maxTokens: number
): ReadonlyArray<ConversationMessage> => {
  const scored = messages.map((message, index) => ({
    message,
    score:
      (message.role === "System" ? 1_000 : 0) +
      (message.role === "Tool" ? 600 : 0) +
      (message.important ? 400 : 0) +
      index
  }))
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      DateTime.toEpochMillis(left.message.timestamp) -
        DateTime.toEpochMillis(right.message.timestamp)
  )

  let used = 0
  const selected: Array<ConversationMessage> = []
  for (const candidate of scored) {
    if (used + candidate.message.tokens <= maxTokens) {
      used += candidate.message.tokens
      selected.push(candidate.message)
    }
  }

  return selected.sort(
    (left, right) =>
      DateTime.toEpochMillis(left.timestamp) - DateTime.toEpochMillis(right.timestamp)
  )
}

const summarizeOldMessages = <R>(
  messages: ReadonlyArray<ConversationMessage>,
  maxTokens: number,
  summaryTargetTokens: number,
  provider: LlmProvider,
  tokenCounter: TokenCounter,
  summarizer: MessageSummarizer<R>
): Effect.Effect<ReadonlyArray<ConversationMessage>, ContextError, R> => {
  if (messages.length <= 2) {
    return Effect.succeed(dropOldest(messages, maxTokens))
  }

  const splitIndex = Math.max(1, Math.floor(messages.length / 2))
  const oldMessages = messages.slice(0, splitIndex)
  const recentMessages = messages.slice(splitIndex)

  return Effect.map(summarizer.summarize(oldMessages, summaryTargetTokens), (summary) => {
    const annotatedSummary = ConversationMessage.make({
      ...summary,
      tokens: tokenCounter.countMessage(provider, summary)
    })
    return dropOldest([annotatedSummary, ...recentMessages], maxTokens)
  })
}

export function applyContextWindow(
  messages: ReadonlyArray<ConversationMessage>,
  provider: LlmProvider,
  limits: ContextLimits,
  strategy: DropOldestFifo | SlidingWindow | PriorityBased,
  tokenCounter?: TokenCounter
): Effect.Effect<ContextWindow, ContextError>
export function applyContextWindow(
  messages: ReadonlyArray<ConversationMessage>,
  provider: LlmProvider,
  limits: ContextLimits,
  strategy: ContextTrimmingStrategy,
  tokenCounter?: TokenCounter
): Effect.Effect<ContextWindow, ContextError, Crypto.Crypto>
export function applyContextWindow<R>(
  messages: ReadonlyArray<ConversationMessage>,
  provider: LlmProvider,
  limits: ContextLimits,
  strategy: ContextTrimmingStrategy,
  tokenCounter: TokenCounter,
  summarizer: MessageSummarizer<R>
): Effect.Effect<ContextWindow, ContextError, R>
export function applyContextWindow<R>(
  messages: ReadonlyArray<ConversationMessage>,
  provider: LlmProvider,
  limits: ContextLimits,
  strategy: ContextTrimmingStrategy,
  tokenCounter: TokenCounter = defaultTokenCounter,
  summarizer?: MessageSummarizer<R>
): Effect.Effect<ContextWindow, ContextError, R | Crypto.Crypto> {
  if (limits.maxTokens <= 0) {
    return Effect.fail(
      ContextInvalidInput.make({
        message: "maxTokens must be > 0"
      })
    )
  }

  const withTokens = annotateTokens(messages, provider, tokenCounter)
  const totalBefore = withTokens.reduce((total, message) => total + message.tokens, 0)

  const trimmed: Effect.Effect<
    readonly [messages: ReadonlyArray<ConversationMessage>, wasTrimmed: boolean],
    ContextError,
    R | Crypto.Crypto
  > =
    totalBefore <= limits.maxTokens
      ? Effect.succeed([withTokens, false])
      : (() => {
          switch (strategy._tag) {
            case "DropOldestFifo":
              return Effect.succeed([dropOldest(withTokens, limits.maxTokens), true])
            case "SlidingWindow":
              return Effect.succeed([slidingWindow(withTokens, limits.maxTokens), true])
            case "PriorityBased":
              return Effect.succeed([priorityWindow(withTokens, limits.maxTokens), true])
            case "SummarizeOldMessages": {
              const summarized: Effect.Effect<
                ReadonlyArray<ConversationMessage>,
                ContextError,
                R | Crypto.Crypto
              > = summarizer === undefined
                ? summarizeOldMessages(
                    withTokens,
                    limits.maxTokens,
                    strategy.summaryTargetTokens,
                    provider,
                    tokenCounter,
                    simpleMessageSummarizer
                  )
                : summarizeOldMessages(
                    withTokens,
                    limits.maxTokens,
                    strategy.summaryTargetTokens,
                    provider,
                    tokenCounter,
                    summarizer
                  )
              return Effect.map(summarized, (messages) => [messages, true])
            }
          }
        })()

  return Effect.map(trimmed, ([finalMessages, wasTrimmed]) => {
    const totalTokens = finalMessages.reduce((total, message) => total + message.tokens, 0)
    return ContextWindow.make({
      messages: finalMessages,
      totalTokens,
      approachingLimit: totalTokens >= limits.maxTokens * limits.warningThresholdPct,
      trimmed: wasTrimmed
    })
  })
}
