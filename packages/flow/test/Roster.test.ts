import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import {
  AuthenticationError,
  InvalidRequestError,
  ProviderError,
  RateLimitError,
  UsageLimitError
} from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk, Message } from "@llm4ts/core/Models"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  Exclusion,
  ExecutorSpec,
  RosterDocument,
  coderSlotsOf,
  exclusionFor,
  makeRoster,
  makeRosterStateStore,
  mergeRosterDocuments,
  narrowRoster,
  parseDuration,
  priorityOf,
  rosterViolations
} from "@llm4ts/flow/Roster"
import { makeHeldCoder, rosterSeat, type RosterSeat } from "@llm4ts/flow/RosterSeats"

const executor = (
  id: string,
  fields: Partial<ConstructorParameters<typeof ExecutorSpec>[0]> = {}
): ExecutorSpec => ExecutorSpec.make({ id, harness: "pi", roles: ["coder"], ...fields })

const local = executor("pi-local", { priority: 1, health: "http://local/v1/models" })
const onPrem = executor("lemonade", { harness: "opencode", priority: 1 })
const codex = executor("codex", {
  harness: "codex",
  roles: ["coder", "reviewer", "judge"],
  slots: 2,
  priority: { coder: 2, default: 2 }
})
const claude = executor("claude", {
  harness: "claude",
  roles: ["coder", "reviewer", "judge", "verifier", "planner"],
  slots: 3,
  priority: { coder: 3, default: 1 }
})

const at = (iso: string): number => DateTime.makeUnsafe(iso).epochMilliseconds

describe("Roster documents", () => {
  it("merges the repository roster over the user's by id and narrows by --executors", () => {
    const user = RosterDocument.make({ executors: [local, codex, claude] })
    const repo = RosterDocument.make({
      executors: [
        executor("codex", { harness: "codex", disabled: true }),
        executor("pi-local", { slots: 1, priority: 5 }),
        onPrem
      ]
    })
    const merged = mergeRosterDocuments(user, repo)
    assert.deepStrictEqual(
      merged.executors.map((spec) => spec.id),
      ["pi-local", "claude", "lemonade"]
    )
    assert.strictEqual(merged.executors[0]?.priority, 5)
    assert.deepStrictEqual(
      narrowRoster(merged, ["claude"]).executors.map((spec) => spec.id),
      ["claude"]
    )
  })

  it("lists every violation at once", () => {
    const violations = rosterViolations(
      RosterDocument.make({
        executors: [
          executor("a", { roles: ["coder", "boss"] }),
          executor("a", { slots: 0 }),
          executor("b", { roles: [], coderSlots: 3 }),
          executor("c", { cooldown: { usageLimit: "soon" } })
        ]
      })
    )
    assert.include(violations.join("\n"), "unknown role(s) boss")
    assert.include(violations.join("\n"), "executor 'a' is listed twice")
    assert.include(violations.join("\n"), "whole number of slots")
    assert.include(violations.join("\n"), "executor 'b' takes no role")
    assert.include(violations.join("\n"), "coderSlots outside 0..slots")
    assert.include(violations.join("\n"), "unreadable usageLimit cooldown 'soon'")
  })

  it("keeps a reasoning slot on an executor that also codes, and reads priorities per role", () => {
    assert.strictEqual(coderSlotsOf(claude), 2)
    assert.strictEqual(coderSlotsOf(codex), 1)
    assert.strictEqual(coderSlotsOf(local), 1)
    assert.strictEqual(coderSlotsOf(executor("x", { slots: 3 })), 3)
    assert.strictEqual(
      coderSlotsOf(executor("y", { roles: ["coder", "judge"], slots: 3, coderSlots: 3 })),
      3
    )
    assert.strictEqual(priorityOf(claude, "coder"), 3)
    assert.strictEqual(priorityOf(claude, "judge"), 1)
    assert.strictEqual(priorityOf(local, "coder"), 1)
    assert.strictEqual(priorityOf(executor("z"), "coder"), 1)
    assert.strictEqual(parseDuration("30 minutes")?.toString(), parseDuration("30m")?.toString())
    assert.isUndefined(parseDuration("soon"))
  })
})

describe("exclusionFor", () => {
  const now = at("2026-09-24T10:00:00Z")

  it("maps only infrastructure failures to exclusions", () => {
    const reset = DateTime.makeUnsafe("2026-09-24T12:30:00Z")
    const limited = exclusionFor(
      UsageLimitError.make({ provider: "codex", message: "try again at 2:30 PM", resetAt: reset }),
      codex,
      now,
      0
    )
    assert.strictEqual(limited?.kind, "until")
    assert.strictEqual(limited?.until, reset.epochMilliseconds)

    const noReset = exclusionFor(
      UsageLimitError.make({ provider: "pi", message: "usage limit" }),
      local,
      now,
      0
    )
    assert.strictEqual(noReset?.until, now + 30 * 60_000)

    assert.isUndefined(exclusionFor(RateLimitError.make({}), codex, now, 2))
    assert.strictEqual(
      exclusionFor(RateLimitError.make({}), codex, now, 3)?.until,
      now + 10 * 60_000
    )

    const down = ProviderError.make({ message: "503: engine is recovering; retry shortly" })
    assert.strictEqual(exclusionFor(down, local, now, 0)?.kind, "health")
    assert.strictEqual(exclusionFor(down, onPrem, now, 0)?.until, now + 5 * 60_000)

    assert.strictEqual(
      exclusionFor(AuthenticationError.make({ message: "not logged in" }), claude, now, 0)?.kind,
      "run"
    )
    // The quality of the work never excludes the executor.
    assert.isUndefined(exclusionFor(ProviderError.make({ message: "tests failed" }), local, now, 0))
    assert.isUndefined(exclusionFor(InvalidRequestError.make({ message: "bad" }), local, now, 0))
  })
})

describe("Roster leasing", () => {
  it.effect("fills by priority, takes turns within one, and keeps coder slots apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const roster = yield* makeRoster({ executors: [local, onPrem, codex, claude], events })
        assert.strictEqual(roster.slots("coder"), 1 + 1 + 1 + 2)
        assert.strictEqual(yield* roster.available("coder"), 5)

        const order: Array<string> = []
        for (let index = 0; index < 5; index += 1) {
          order.push((yield* roster.lease("coder")).executor.id)
        }
        assert.deepStrictEqual(order, ["pi-local", "lemonade", "codex", "claude", "claude"])
        assert.strictEqual(yield* roster.available("coder"), 0)
        assert.isUndefined(yield* roster.tryLease("coder"))
        // One slot on each reasoning executor stayed out of the coders' reach.
        assert.strictEqual((yield* roster.lease("judge")).executor.id, "claude")
        assert.strictEqual((yield* roster.lease("judge")).executor.id, "codex")
        const recorded = yield* events.recorded
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "Info" && event.message === "roster: pi-local takes coder"
          )
        )
      })
    )
  )

  it.effect("a preferred executor wins while free, and a released slot is leased again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const roster = yield* makeRoster({ executors: [local, codex], events })
        const first = yield* roster.lease("coder", { prefer: "codex" })
        assert.strictEqual(first.executor.id, "codex")
        yield* first.release
        yield* first.release
        assert.strictEqual((yield* roster.lease("coder", { prefer: "codex" })).executor.id, "codex")
      })
    )
  )

  it.effect("waits for an excluded executor's time, and fails when none can ever serve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const roster = yield* makeRoster({ executors: [codex], events })
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        yield* roster.exclude(
          Exclusion.make({ id: "codex", kind: "until", until: now + 60_000, reason: "usage limit" })
        )
        const waiting = yield* Effect.forkScoped(roster.lease("coder"))
        yield* TestClock.adjust("30 seconds")
        assert.isUndefined(waiting.pollUnsafe())
        yield* TestClock.adjust("31 seconds")
        const lease = yield* Fiber.join(waiting)
        assert.strictEqual(lease.executor.id, "codex")
        const recorded = (yield* events.recorded).flatMap((event) =>
          event._tag === "Info" ? [event.message] : []
        )
        assert.isTrue(
          recorded.some((message) =>
            message.startsWith("roster: waiting for an executor to take coder")
          )
        )
        assert.isTrue(recorded.includes("roster: codex back in the round"))

        yield* roster.exclude(Exclusion.make({ id: "codex", kind: "run", reason: "not logged in" }))
        const exhausted = yield* Effect.flip(roster.lease("judge"))
        assert.strictEqual(exhausted._tag, "RosterExhausted")
        assert.include(exhausted.message, "codex for this run: not logged in")
        const nobody = yield* Effect.flip(roster.lease("planner"))
        assert.include(nobody.message, "no executor in the roster takes this role")
      })
    )
  )

  it.effect("probes a health exclusion while someone waits, and a manual pause holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const up = yield* Ref.make(false)
        const roster = yield* makeRoster({
          executors: [local],
          events,
          probe: () => Ref.get(up)
        })
        const excluded = yield* roster.report(
          "pi-local",
          ProviderError.make({ message: "Metal backend is unhealthy" })
        )
        assert.strictEqual(excluded?.kind, "health")
        const waiting = yield* Effect.forkScoped(roster.lease("coder"))
        yield* TestClock.adjust("15 seconds")
        assert.isUndefined(waiting.pollUnsafe())
        yield* Ref.set(up, true)
        yield* TestClock.adjust("15 seconds")
        assert.strictEqual((yield* Fiber.join(waiting)).executor.id, "pi-local")

        yield* roster.exclude(
          Exclusion.make({ id: "pi-local", kind: "manual", reason: "operator" })
        )
        assert.strictEqual(yield* roster.available("coder"), 0)
        yield* roster.resume("pi-local")
        assert.isTrue((yield* roster.snapshot).every((status) => status.exclusion === undefined))
      })
    )
  )

  it.effect("three rate limits in the window exclude; exclusions with an end persist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const memory = yield* makeMemoryPlainFileStore()
        const state = makeRosterStateStore(memory.store, "/state/roster-state.json")
        const roster = yield* makeRoster({ executors: [codex, claude], events, state })
        assert.isUndefined(yield* roster.report("codex", RateLimitError.make({})))
        assert.isUndefined(yield* roster.report("codex", RateLimitError.make({})))
        assert.strictEqual((yield* roster.report("codex", RateLimitError.make({})))?.kind, "until")
        yield* roster.report("claude", AuthenticationError.make({ message: "logged out" }))

        const saved = yield* state.load
        assert.deepStrictEqual(
          saved.map((exclusion) => [exclusion.id, exclusion.kind]),
          [["codex", "until"]]
        )
        // A new run starts with what the last one learned.
        const next = yield* makeRoster({ executors: [codex, claude], events, state })
        assert.strictEqual(
          (yield* next.snapshot).find((status) => status.executor.id === "codex")?.exclusion?.kind,
          "until"
        )
        yield* TestClock.adjust("11 minutes")
        assert.strictEqual((yield* state.load).length, 0)
      })
    )
  )
})

// ---- Seats ---------------------------------------------------------------------------

const unused = InvalidRequestError.make({ message: "unused" })

/** A seat that records which executor answered, failing while `failing` says so. */
const seatFor =
  (log: Ref.Ref<ReadonlyArray<string>>, failing: (id: string) => ProviderError | undefined) =>
  (spec: ExecutorSpec, role: string, _workDir: string): Effect.Effect<RosterSeat> => {
    const answer = (prompt: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Ref.update(log, (all) => [...all, `${spec.id}:${role}:${prompt}`])
          const failure = failing(spec.id)
          return failure === undefined
            ? Stream.make(LlmChunk.make({ delta: `${spec.id} ok`, finishReason: "stop" }))
            : Stream.fail(failure)
        })
      )
    const seat: RosterSeat = {
      executeStream: answer,
      executeStreamWithHistory: (messages) => answer(messages.at(-1)?.content ?? ""),
      executeWithTools: () => Effect.fail(unused),
      executeStructured: () => Effect.fail(unused),
      executeStructuredWithUsage: () => Effect.fail(unused),
      scoreLabels: unsupportedScoreLabels,
      isAvailable: Effect.succeed(true),
      capabilities: ConnectorCapabilities.make({})
    }
    return Effect.succeed(seat)
  }

const text = (service: LlmServiceShape, prompt: string): Effect.Effect<string, unknown> =>
  Effect.map(
    Stream.runCollect(
      service.executeStreamWithHistory([Message.make({ role: "User", content: prompt })])
    ),
    (chunks) => chunks.map((chunk) => chunk.delta).join("")
  )

describe("Roster seats", () => {
  it.effect("a held coder hands over when its executor is taken out, at most twice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const roster = yield* makeRoster({ executors: [local, codex, claude], events })
        const down = ProviderError.make({ message: "engine is recovering" })
        const limit = UsageLimitError.make({ provider: "codex", message: "usage limit" })
        const failing = (id: string) =>
          id === "pi-local"
            ? down
            : id === "codex"
              ? ProviderError.make({ message: limit.message })
              : undefined
        const held = yield* makeHeldCoder(roster, { seatFor: seatFor(log, failing) }, "/wt/a", {
          events,
          eager: true,
          label: "story a"
        })
        assert.strictEqual(yield* held.executor, "pi-local")
        // codex's failure is a plain provider error here, so it is not excluded:
        // the hold moves local → codex, and codex's failure surfaces.
        const first = yield* Effect.flip(text(held.service, "task 1"))
        assert.include(String(first), "usage limit")
        assert.deepStrictEqual(yield* held.history, ["pi-local", "codex"])
        const calls = yield* Ref.get(log)
        assert.include(
          calls[1] ?? "",
          "You are taking over this work from another coding agent ('pi-local')"
        )
      })
    )
  )

  it.effect("the handover cap surfaces the third failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const roster = yield* makeRoster({ executors: [local, onPrem, codex, claude], events })
        const down = ProviderError.make({ message: "engine is recovering" })
        const held = yield* makeHeldCoder(
          roster,
          { seatFor: seatFor(log, (id) => (id === "claude" ? undefined : down)) },
          "/wt/a",
          { events, eager: false }
        )
        assert.isUndefined(yield* held.executor)
        const failure = yield* Effect.flip(text(held.service, "go"))
        assert.include(String(failure), "engine is recovering")
        assert.deepStrictEqual(yield* held.history, ["pi-local", "lemonade", "codex"])
        const cleared = yield* makeHeldCoder(
          roster,
          { seatFor: seatFor(log, (id) => (id === "claude" ? undefined : down)) },
          "/wt/b",
          { events, eager: false }
        )
        // Everyone else is out now: the next hold goes straight to claude.
        assert.strictEqual(yield* text(cleared.service, "go"), "claude ok")
      })
    )
  )

  it.effect("per-call seats avoid the context's coder, and borrow it when nobody else can", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const roster = yield* makeRoster({ executors: [codex, claude], events })
        const source = { seatFor: seatFor(log, () => undefined) }
        const judge = rosterSeat(roster, source, "judge", "/wt/a", {
          events,
          avoid: Effect.succeed(["claude"]),
          borrow: Effect.succeed(claude)
        })
        assert.strictEqual(yield* text(judge, "judge a"), "codex ok")
        const verifier = rosterSeat(roster, source, "verifier", "/wt/a", {
          events,
          avoid: Effect.succeed(["claude"]),
          borrow: Effect.succeed(claude)
        })
        assert.strictEqual(yield* text(verifier, "verify a"), "claude ok")
        const recorded = (yield* events.recorded).flatMap((event) =>
          event._tag === "Info" ? [event.message] : []
        )
        assert.isTrue(recorded.some((message) => message.includes("not independent")))
        // The slot went back when the call ended.
        assert.strictEqual(yield* roster.available("judge"), 2 + 3)
      })
    )
  )
})
