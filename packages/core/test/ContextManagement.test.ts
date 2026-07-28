import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ContextLimits,
  ContextTrimmingStrategies,
  applyContextWindow,
  defaultTokenCounter,
  type MessageSummarizer
} from "@llm4ts/core/ContextManagement"
import { ConversationMessage, type PromptRole } from "@llm4ts/core/Conversation"

const message = (
  id: string,
  role: PromptRole,
  content: string,
  tokens: number,
  timestamp: number,
  important = false
): ConversationMessage =>
  ConversationMessage.make({
    id,
    role,
    content,
    tokens,
    timestamp: DateTime.makeUnsafe(timestamp),
    important
  })

describe("ContextManagement", () => {
  it.effect("round-trips context messages through their JSON codec", () =>
    Effect.gen(function* () {
      const original = message("m1", "Tool", "result", 7, 1, true)
      const codec = Schema.toCodecJson(ConversationMessage)
      const encoded = yield* Schema.encodeEffect(codec)(original)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded)

      assert.deepStrictEqual(decoded, original)
    })
  )

  it("returns provider-specific token estimates", () => {
    const text = "A".repeat(100)
    const openAi = defaultTokenCounter.countText("OpenAI", text)
    const anthropic = defaultTokenCounter.countText("Anthropic", text)
    const ollama = defaultTokenCounter.countText("Ollama", text)

    assert.isAbove(openAi, 0)
    assert.isAbove(anthropic, 0)
    assert.isAbove(ollama, 0)
    assert.isAtLeast(anthropic, openAi)
  })

  it.effect("drop-oldest FIFO keeps the most recent messages within budget", () =>
    Effect.gen(function* () {
      const window = yield* applyContextWindow(
        [
          message("1", "User", "a", 20, 1),
          message("2", "User", "b", 20, 2),
          message("3", "User", "c", 20, 3)
        ],
        "OpenAI",
        ContextLimits.make({ maxTokens: 40 }),
        ContextTrimmingStrategies.DropOldestFifo
      )

      assert.deepStrictEqual(
        window.messages.map((item) => item.id),
        ["2", "3"]
      )
      assert.strictEqual(window.totalTokens, 40)
      assert.isTrue(window.trimmed)
    })
  )

  it.effect("sliding windows preserve system messages", () =>
    Effect.gen(function* () {
      const window = yield* applyContextWindow(
        [
          message("s", "System", "system", 10, 1, true),
          message("1", "User", "a", 20, 2),
          message("2", "Assistant", "b", 20, 3)
        ],
        "OpenAI",
        ContextLimits.make({ maxTokens: 30 }),
        ContextTrimmingStrategies.SlidingWindow
      )

      assert.isTrue(window.messages.some((item) => item.role === "System"))
      assert.isAtMost(window.totalTokens, 30)
      assert.deepStrictEqual(
        window.messages.map((item) => item.id),
        ["s", "2"]
      )
    })
  )

  it.effect("priority trimming preserves important and tool messages", () =>
    Effect.gen(function* () {
      const window = yield* applyContextWindow(
        [
          message("1", "User", "old", 20, 1),
          message("2", "Tool", "tool", 15, 2),
          message("3", "Assistant", "important", 15, 3, true)
        ],
        "OpenAI",
        ContextLimits.make({ maxTokens: 30 }),
        ContextTrimmingStrategies.PriorityBased
      )

      assert.isTrue(window.messages.some((item) => item.role === "Tool"))
      assert.isTrue(window.messages.some((item) => item.important))
      assert.isAtMost(window.totalTokens, 30)
    })
  )

  it.effect("summary trimming replaces older history through the supplied summarizer", () => {
    const summarizer: MessageSummarizer = {
      summarize: (_messages, targetTokens) =>
        Effect.succeed(
          ConversationMessage.make({
            id: "summary",
            role: "Assistant",
            content: "previous context",
            timestamp: DateTime.makeUnsafe(2),
            tokens: targetTokens,
            metadata: { summary: "true" },
            important: true
          })
        )
    }

    return Effect.gen(function* () {
      const window = yield* applyContextWindow(
        [
          message("1", "User", "old1", 20, 1),
          message("2", "Assistant", "old2", 20, 2),
          message("3", "User", "recent", 20, 3)
        ],
        "OpenAI",
        ContextLimits.make({ maxTokens: 35 }),
        ContextTrimmingStrategies.SummarizeOldMessages(10),
        defaultTokenCounter,
        summarizer
      )

      assert.isTrue(window.messages.some((item) => item.metadata.summary === "true"))
      assert.isAtMost(window.totalTokens, 35)
      assert.isTrue(window.trimmed)
    })
  })

  it.effect("annotates uncounted messages and marks an approaching limit", () =>
    Effect.gen(function* () {
      const window = yield* applyContextWindow(
        [message("1", "User", "A".repeat(20), 0, 1)],
        "OpenAI",
        ContextLimits.make({
          maxTokens: 12,
          warningThresholdPct: 0.8
        }),
        ContextTrimmingStrategies.DropOldestFifo
      )

      assert.isAbove(window.messages[0]?.tokens ?? 0, 0)
      assert.isTrue(window.approachingLimit)
      assert.isFalse(window.trimmed)
    })
  )

  it.effect("rejects non-positive token budgets", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        applyContextWindow(
          [],
          "OpenAI",
          ContextLimits.make({ maxTokens: 0 }),
          ContextTrimmingStrategies.DropOldestFifo
        )
      )

      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "InvalidInput")
      }
    })
  )
})
