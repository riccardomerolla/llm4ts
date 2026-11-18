import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import { SpaceRef } from "@llm4ts/flow/GoogleChatTool"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { InterruptSignal } from "@llm4ts/runner/FlowRunner"
import type { ChatLoopDeps } from "@llm4ts/shell/ChatLoop"
import { chatOptionsFrom, runChatUntilSignal, type ChatFlags } from "@llm4ts/shell/ChatNode"
import { makeFakeFlowProcess } from "@llm4ts/shell/FlowProcess"
import { makeRunSupervisor } from "@llm4ts/shell/RunSupervisor"
import { makeFakeChat } from "./support/FakeChat.ts"
import { fakeGit } from "./support/FakeGit.ts"

const none: ChatFlags = {
  space: Option.none(),
  trigger: Option.none(),
  marker: Option.none(),
  allow: [],
  flows: Option.none(),
  interval: Option.none(),
  observe: false
}

const withSpace: ChatFlags = { ...none, space: Option.some("spaces/AAA") }

const refusal = (flags: ChatFlags, environment: Record<string, string> = {}) =>
  Effect.map(Effect.flip(chatOptionsFrom(flags, environment)), (error) => {
    assert.strictEqual(error._tag, "ShellUsage")
    return error.message
  })

describe("chatOptionsFrom", () => {
  it.effect("defaults the trigger, marker, interval and flows", () =>
    Effect.gen(function* () {
      const options = yield* chatOptionsFrom(withSpace, {})
      assert.deepStrictEqual(options, {
        space: new SpaceRef({ id: "AAA" }),
        trigger: "/bot",
        marker: "🌙 chief:",
        allow: [],
        flows: ["implement"],
        intervalSeconds: 5,
        observe: false
      })
    })
  )

  it.effect("takes the space and trigger from the settings", () =>
    Effect.gen(function* () {
      const options = yield* chatOptionsFrom(none, {
        LLM4TS_CHAT_SPACE: "BBB",
        LLM4TS_CHAT_TRIGGER: "@bot"
      })
      assert.strictEqual(options.space.name, "spaces/BBB")
      assert.strictEqual(options.trigger, "@bot")
    })
  )

  it.effect("lets a flag beat the setting", () =>
    Effect.gen(function* () {
      const options = yield* chatOptionsFrom(
        { ...withSpace, trigger: Option.some("bot:") },
        { LLM4TS_CHAT_SPACE: "BBB", LLM4TS_CHAT_TRIGGER: "@bot" }
      )
      assert.strictEqual(options.space.name, "spaces/AAA")
      assert.strictEqual(options.trigger, "bot:")
    })
  )

  it.effect("reads the other flags", () =>
    Effect.gen(function* () {
      const options = yield* chatOptionsFrom(
        {
          ...withSpace,
          marker: Option.some("🤖 cos:"),
          allow: ["users/123"],
          flows: Option.some(" implement, taskforce ,implement,"),
          interval: Option.some(2),
          observe: true
        },
        {}
      )
      assert.strictEqual(options.marker, "🤖 cos:")
      assert.deepStrictEqual(options.allow, ["users/123"])
      assert.deepStrictEqual(options.flows, ["implement", "taskforce"])
      assert.strictEqual(options.intervalSeconds, 2)
      assert.isTrue(options.observe)
    })
  )

  it.effect("refuses no space", () =>
    Effect.gen(function* () {
      assert.match(yield* refusal(none), /--space spaces\/AAAA… or LLM4TS_CHAT_SPACE/)
    })
  )

  it.effect("refuses a space that does not parse", () =>
    Effect.gen(function* () {
      assert.match(
        yield* refusal({ ...none, space: Option.some("rooms/A A") }),
        /is not a Chat space/
      )
    })
  )

  it.effect("refuses an --allow that is not a user id", () =>
    Effect.gen(function* () {
      assert.match(
        yield* refusal({ ...withSpace, allow: ["users/1", "ann@example.com"] }),
        /--allow takes a user id .*ann@example.com/
      )
    })
  )

  it.effect("refuses an interval under 1", () =>
    Effect.gen(function* () {
      assert.match(yield* refusal({ ...withSpace, interval: Option.some(0) }), /--interval/)
    })
  )

  it.effect("refuses empty --flows", () =>
    Effect.gen(function* () {
      assert.match(yield* refusal({ ...withSpace, flows: Option.some(" , ") }), /--flows/)
    })
  )
})

const fakeSignals = () => {
  const handlers = new Map<InterruptSignal, () => void>()
  return {
    handlers,
    source: {
      once: (signal: InterruptSignal, handler: () => void) => {
        handlers.set(signal, handler)
      },
      off: (signal: InterruptSignal, handler: () => void) => {
        if (handlers.get(signal) === handler) handlers.delete(signal)
      },
      exit: () => undefined
    }
  }
}

describe("runChatUntilSignal", () => {
  it.effect("ends cleanly on SIGINT and removes its handlers", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const fake = yield* makeFakeFlowProcess()
      const chat = yield* makeFakeChat()
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const repo = { id: "app", path: "/work/app" }
      const signals = fakeSignals()
      const deps = Effect.gen(function* () {
        const supervisor = yield* makeRunSupervisor({
          repos: [repo],
          environment: { HOME: "/home/op", XDG_STATE_HOME: "/state" },
          files: memory.store,
          process: fake.process,
          parallelRuns: 1
        })
        return {
          chat: chat.tool,
          files: memory.store,
          supervisor,
          git: fakeGit(
            yield* Ref.make<ReadonlyArray<string>>([]),
            yield* Ref.make<ReadonlyArray<string>>([])
          ),
          repo,
          flows: Effect.succeed([]),
          sources: { files: memory.store, listFiles: () => [] },
          listTraces: () => [],
          listEpics: () => [],
          decide: () => Effect.die("no request is sent"),
          environment: {},
          now: Clock.currentTimeMillis,
          say: (line: string) => Ref.update(lines, (all) => [...all, line]),
          strangers: yield* Ref.make<ReadonlySet<string>>(new Set()),
          seatProblem: Effect.succeed(undefined),
          ignored: Effect.succeed(true),
          options: {
            space: new SpaceRef({ id: "AAA" }),
            trigger: "/bot",
            marker: "🌙 chief:",
            allow: [],
            flows: ["implement"],
            intervalSeconds: 5,
            observe: false
          }
        } satisfies ChatLoopDeps
      })
      const fiber = yield* Effect.forkChild(runChatUntilSignal(deps, signals.source))
      // Listening means the loop is up and the handlers are in place.
      for (let turn = 0; turn < 1_000 && (yield* chat.posted).length === 0; turn++) {
        yield* Effect.yieldNow
      }
      assert.isTrue(signals.handlers.has("SIGINT"))
      signals.handlers.get("SIGINT")?.()
      yield* Fiber.join(fiber)
      assert.strictEqual(signals.handlers.size, 0)
      assert.deepStrictEqual(yield* Ref.get(lines), [
        "Stopping; runs started from chat are stopped too."
      ])
      assert.lengthOf(yield* chat.posted, 1)
    })
  )
})
