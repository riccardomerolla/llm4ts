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
  UsageLimitError,
  type LlmError
} from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk, Message } from "@llm4ts/core/Models"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import {
  makeCollectingFlowEvents,
  rosterEventMessage,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
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
import {
  makeHeldCoder,
  rosterSeat,
  type HeldCoder,
  type RosterSeat
} from "@llm4ts/flow/RosterSeats"

/** What the classic terminal shows for the roster's events, in order. */
const rosterLines = (recorded: ReadonlyArray<FlowEvent>): ReadonlyArray<string> =>
  recorded.flatMap((event) => {
    const message = rosterEventMessage(event)
    return message === undefined ? (event._tag === "Info" ? [event.message] : []) : [message]
  })

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
    // A model the harness cannot serve sits the run out.
    const badModel = exclusionFor(
      ProviderError.make({
        message:
          "claude exited with code 1: There's an issue with the selected model (claude-opus-5.5)."
      }),
      claude,
      now,
      0
    )
    assert.strictEqual(badModel?.kind, "run")
    assert.include(badModel?.reason ?? "", "is unavailable")
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
        const leased = recorded.find((event) => event._tag === "ExecutorLeased")
        assert.deepStrictEqual(
          leased?._tag === "ExecutorLeased" ? [leased.executor, leased.role] : [],
          ["pi-local", "coder"]
        )
        assert.isFalse(recorded.some((event) => event._tag === "Info"))
        assert.include(rosterLines(recorded), "roster: pi-local takes coder")
      })
    )
  )

  it.effect(
    "publishes typed events for a story's lease, its release, an exclusion and a resume",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* makeCollectingFlowEvents
          const roster = yield* makeRoster({ executors: [codex, claude], events })
          const lease = yield* roster.lease("coder", { label: "home" })
          yield* lease.release
          yield* lease.release
          yield* roster.exclude(
            Exclusion.make({ id: "claude", kind: "run", reason: "not logged in" })
          )
          yield* roster.resume("claude")
          const recorded = (yield* events.recorded).filter((event) =>
            event._tag.startsWith("Executor")
          )
          assert.deepStrictEqual(
            recorded.map((event) => event._tag),
            ["ExecutorLeased", "ExecutorReleased", "ExecutorExcluded", "ExecutorResumed"]
          )
          const [leased, released] = recorded
          assert.isTrue(
            leased?._tag === "ExecutorLeased" &&
              leased.executor === lease.executor.id &&
              leased.label === "home"
          )
          assert.isTrue(released?._tag === "ExecutorReleased" && released.label === "home")
          assert.deepStrictEqual(rosterLines(recorded), [
            `roster: ${lease.executor.id} takes coder for home`,
            "roster: claude out of the round for this run: not logged in",
            "roster: claude resumed"
          ])
        })
      )
  )

  it.effect("a preferred executor wins while it ranks with the best free one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const roster = yield* makeRoster({ executors: [local, onPrem, codex], events })
        // Equal priority: continuity wins over taking turns.
        const first = yield* roster.lease("coder", { prefer: "lemonade" })
        assert.strictEqual(first.executor.id, "lemonade")
        yield* first.release
        yield* first.release
        // A lower-ranked preference loses to the operator's priorities (the
        // demo's home story kept a slow coder after codex was moved first).
        const ranked = yield* roster.lease("coder", { prefer: "codex" })
        assert.strictEqual(ranked.executor.id, "pi-local")
        // …but still takes the slot when nothing better is free.
        yield* roster.lease("coder")
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
        const recorded = rosterLines(yield* events.recorded)
        assert.isTrue(
          recorded.some((message) =>
            message.startsWith("roster: waiting for an executor to take coder")
          )
        )
        assert.isTrue(recorded.includes("roster: codex back in the round"))
        const waited = (yield* events.recorded).flatMap((event) =>
          event._tag === "Timed" ? [[event.kind, event.label, event.ms]] : []
        )
        assert.deepStrictEqual(waited, [["wait", "roster coder", 60_000]])

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
  (log: Ref.Ref<ReadonlyArray<string>>, failing: (id: string) => LlmError | undefined) =>
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

  it.effect("a per-call seat moves once to another executor when its own is taken out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const roster = yield* makeRoster({ executors: [codex, claude], events })
        const badModel = ProviderError.make({
          message: "There's an issue with the selected model (claude-opus-5.5)."
        })
        const judge = rosterSeat(
          roster,
          { seatFor: seatFor(log, (id) => (id === "claude" ? badModel : undefined)) },
          "judge",
          "/wt/a",
          { events, label: "story a" }
        )
        // claude is the judge's first choice, fails, is out for the run; codex answers.
        assert.strictEqual(yield* text(judge, "judge a"), "codex ok")
        const snapshot = yield* roster.snapshot
        assert.strictEqual(
          snapshot.find((status) => status.executor.id === "claude")?.exclusion?.kind,
          "run"
        )
        const recorded = yield* events.recorded
        assert.isTrue(
          rosterLines(recorded).some((message) =>
            message.includes("judge for story a moves off claude")
          )
        )
        const moved = recorded.find((event) => event._tag === "ExecutorHandedOver")
        assert.deepStrictEqual(
          moved?._tag === "ExecutorHandedOver" ? [moved.from, moved.role, moved.label] : [],
          ["claude", "judge", "story a"]
        )
        // A failure that says nothing about the executor is the call's own.
        const flaky = rosterSeat(
          roster,
          { seatFor: seatFor(log, () => ProviderError.make({ message: "bad JSON" })) },
          "judge",
          "/wt/a",
          { events }
        )
        assert.include(String(yield* Effect.flip(text(flaky, "judge again"))), "bad JSON")
      })
    )
  )

  // The rehearsal of 2026-10-06: codex coding, claude reviewing, claude's
  // "You've hit your session limit · resets 8:20am (Europe/Rome)". The review
  // must move to codex's free reasoning slot, not fail the story.
  it.effect(
    "a review moves to its own executor's free slot when the independent one hits its limit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* makeCollectingFlowEvents
          const log = yield* Ref.make<ReadonlyArray<string>>([])
          const roster = yield* makeRoster({ executors: [codex, claude], events })
          const limit = UsageLimitError.make({
            provider: "claude",
            message:
              "claude exited with code 1: You've hit your session limit · resets 8:20am (Europe/Rome)",
            resetAt: DateTime.makeUnsafe("2026-10-06T06:20:00Z")
          })
          const source = { seatFor: seatFor(log, (id) => (id === "claude" ? limit : undefined)) }
          const story = yield* makeHeldCoder(roster, source, "a", {
            events,
            eager: true,
            label: "a"
          })
          assert.strictEqual(yield* story.executor, "codex")
          const reviewer = rosterSeat(roster, source, "reviewer", "a", {
            events,
            avoid: Effect.map(story.executor, (id) => (id === undefined ? [] : [id])),
            borrow: story.lease,
            label: "a"
          })
          assert.strictEqual(yield* text(reviewer, "review a"), "codex ok")
          const snapshot = yield* roster.snapshot
          const out = snapshot.find((status) => status.executor.id === "claude")?.exclusion
          assert.deepStrictEqual([out?.kind, out?.until], ["until", at("2026-10-06T06:20:00Z")])
          const lines = rosterLines(yield* events.recorded)
          assert.isTrue(lines.some((line) => line.includes("reviewer for a moves off claude")))
          assert.isTrue(
            lines.includes(
              "roster: codex takes reviewer for a on its own slot — not independent (no other executor can take reviewer)"
            ),
            lines.join("\n")
          )
          // One attempt on claude, one on codex: the limit is not retried on the spot.
          assert.deepStrictEqual(yield* Ref.get(log), [
            "claude:reviewer:review a",
            "codex:reviewer:review a"
          ])
          assert.strictEqual(yield* roster.available("reviewer"), 1)
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
        const recorded = rosterLines(yield* events.recorded)
        assert.isTrue(recorded.some((message) => message.includes("not independent")))
        // The slot went back when the call ended.
        assert.strictEqual(yield* roster.available("judge"), 2 + 3)
      })
    )
  )

  // Two executors with one slot each, both taking every role: the stories
  // hold both slots, and every reviewer call would wait for a story to end —
  // which waits on its own reviewer. The roster is saturated, not busy.
  it.effect("a per-call seat borrows its coder when every other executor is held by a coder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const every = ["planner", "coder", "reviewer", "judge", "verifier"]
        const one = executor("one", { harness: "claude", roles: every })
        const two = executor("two", { harness: "codex", roles: every })
        const roster = yield* makeRoster({ executors: [one, two], events })
        const source = { seatFor: seatFor(log, () => undefined) }
        const held = (dir: string) =>
          makeHeldCoder(roster, source, dir, { events, eager: true, label: dir })
        const a = yield* held("a")
        const b = yield* held("b")
        assert.deepStrictEqual([yield* a.executor, yield* b.executor], ["one", "two"])
        assert.strictEqual(yield* roster.available("reviewer"), 0)
        assert.isTrue(yield* roster.coderHeld("reviewer", ["one"]))
        const reviewerOf = (story: HeldCoder, label: string) =>
          rosterSeat(roster, source, "reviewer", label, {
            events,
            avoid: Effect.map(story.executor, (id) => (id === undefined ? [] : [id])),
            borrow: story.lease,
            label
          })
        const reviewing = yield* Effect.forkScoped(text(reviewerOf(a, "a"), "review a"))
        yield* TestClock.adjust("1 hour")
        assert.strictEqual(yield* Fiber.join(reviewing), "one ok")
        assert.strictEqual(yield* text(reviewerOf(b, "b"), "review b"), "two ok")
        const recorded = yield* events.recorded
        const lines = rosterLines(recorded)
        assert.isTrue(
          lines.includes(
            "roster: one takes reviewer for a on its own coder's slot — not independent (every other executor that takes reviewer is held by a coder)"
          ),
          lines.join("\n")
        )
        // A borrowed lease is released like any other, for the views that count leases.
        const released = recorded.filter(
          (event) => event._tag === "ExecutorReleased" && event.role === "reviewer"
        )
        assert.strictEqual(released.length, 2)
        // Nobody waited: the stories never saw a "waiting for an executor" line.
        assert.isFalse(lines.some((line) => line.includes("waiting for an executor")))
        assert.strictEqual(yield* roster.available("reviewer"), 0)
      })
    )
  )

  it.effect("a per-call seat waits for a call in flight, and borrows once coders take over", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const every = ["planner", "coder", "reviewer", "judge", "verifier"]
        const one = executor("one", { harness: "claude", roles: every })
        const two = executor("two", { harness: "codex", roles: every })
        const roster = yield* makeRoster({ executors: [one, two], events })
        const source = { seatFor: seatFor(log, () => undefined) }
        const a = yield* makeHeldCoder(roster, source, "a", { events, eager: true, label: "a" })
        assert.strictEqual(yield* a.executor, "one")
        // A reasoning call on `two` is in flight: the next reviewer waits for it, not for a story.
        const inFlight = yield* roster.lease("judge", { label: "the run" })
        assert.strictEqual(inFlight.executor.id, "two")
        assert.isFalse(yield* roster.coderHeld("reviewer", ["one"]))
        // Story b is already queued for a coder slot, ahead of the reviewer.
        const b = yield* Effect.forkScoped(
          makeHeldCoder(roster, source, "b", { events, eager: true, label: "b" })
        )
        yield* TestClock.adjust("1 minute")
        assert.isUndefined(b.pollUnsafe())
        const reviewer = rosterSeat(roster, source, "reviewer", "a", {
          events,
          avoid: Effect.map(a.executor, (id) => (id === undefined ? [] : [id])),
          borrow: a.lease,
          label: "a"
        })
        const reviewing = yield* Effect.forkScoped(text(reviewer, "review a"))
        yield* TestClock.adjust("1 minute")
        assert.isUndefined(reviewing.pollUnsafe())
        // The call ends and story b's coder takes the slot: the reviewer
        // gives up on independence instead of waiting for that story to end.
        yield* inFlight.release
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(yield* (yield* Fiber.join(b)).executor, "two")
        assert.strictEqual(yield* Fiber.join(reviewing), "one ok")
        const waited = (yield* events.recorded).flatMap((event) =>
          event._tag === "Timed" && event.kind === "wait" ? [event.label] : []
        )
        assert.deepStrictEqual(waited, ["roster coder", "roster reviewer"])
      })
    )
  )

  // The rehearsal of 2026-10-06: a story coding on codex (two slots, one
  // for coding), claude — the only other reviewer — paused by the operator
  // for hours. The reviewer took nobody and the story sat "waiting for an
  // executor to take reviewer: claude paused until …".
  it.effect("a per-call seat takes its own executor's free slot when every other is out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const roster = yield* makeRoster({ executors: [local, codex, claude], events })
        const source = { seatFor: seatFor(log, () => undefined) }
        yield* roster.lease("coder", { label: "pi" })
        const story = yield* makeHeldCoder(roster, source, "a", { events, eager: true, label: "a" })
        assert.strictEqual(yield* story.executor, "codex")
        yield* roster.exclude(
          Exclusion.make({
            id: "claude",
            kind: "manual",
            until: at("2026-10-06T05:37:30Z"),
            reason: "paused by the operator"
          })
        )
        const reviewer = rosterSeat(roster, source, "reviewer", "a", {
          events,
          avoid: Effect.map(story.executor, (id) => (id === undefined ? [] : [id])),
          borrow: story.lease,
          label: "a"
        })
        assert.strictEqual(yield* roster.independenceBlocked("reviewer", ["codex"]), "out")
        // codex's reasoning slot is free: a real lease, on its own slot, at once.
        assert.strictEqual(yield* text(reviewer, "review a"), "codex ok")
        const lines = rosterLines(yield* events.recorded)
        assert.isTrue(
          lines.includes(
            "roster: codex takes reviewer for a on its own slot — not independent (every other executor that takes reviewer is out of the round)"
          ),
          lines.join("\n")
        )
        assert.isFalse(lines.some((line) => line.includes("waiting for an executor")))
        assert.strictEqual(yield* roster.available("reviewer"), 1)
        // With codex's reasoning slot taken by another call, the seat borrows instead of waiting.
        const other = yield* roster.lease("judge", { label: "the run" })
        assert.strictEqual(other.executor.id, "codex")
        assert.strictEqual(yield* text(reviewer, "review a again"), "codex ok")
        assert.isTrue(
          (yield* events.recorded).some(
            (event) =>
              event._tag === "ExecutorLeased" && event.borrowed === true && event.because === "out"
          )
        )
        yield* other.release
        // Independence is per call: once claude is back, the next review goes there.
        yield* roster.resume("claude")
        assert.strictEqual(yield* text(reviewer, "review a once more"), "claude ok")
      })
    )
  )

  it.effect("the roster never borrows an executor out of the round to escape held coders", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const every = ["planner", "coder", "reviewer", "judge", "verifier"]
        const one = executor("one", { harness: "claude", roles: every })
        const two = executor("two", { harness: "codex", roles: every })
        const roster = yield* makeRoster({ executors: [one, two], events })
        const coderOnTwo = yield* roster.lease("coder", { avoid: ["one"] })
        assert.strictEqual(coderOnTwo.executor.id, "two")
        yield* roster.exclude(
          Exclusion.make({
            id: "one",
            kind: "until",
            until: at("2070-01-01T00:00:00Z"),
            reason: "usage limit"
          })
        )
        // `one` is out: borrowed only when nobody could ever serve, never to
        // sidestep a coder — its story will free the slot.
        const waiting = yield* Effect.forkScoped(
          roster.lease("reviewer", { avoid: ["one"], borrow: one, label: "a" })
        )
        yield* TestClock.adjust("1 minute")
        assert.isUndefined(waiting.pollUnsafe())
        yield* coderOnTwo.release
        const lease = yield* Fiber.join(waiting)
        assert.deepStrictEqual([lease.executor.id, lease.borrowed], ["two", false])
        // With nobody else at all, the out-of-round executor is borrowed, as before.
        yield* roster.exclude(Exclusion.make({ id: "two", kind: "run", reason: "not logged in" }))
        const borrowed = yield* roster.lease("judge", { avoid: ["one"], borrow: one })
        assert.deepStrictEqual([borrowed.executor.id, borrowed.borrowed], ["one", true])
      })
    )
  )
})
