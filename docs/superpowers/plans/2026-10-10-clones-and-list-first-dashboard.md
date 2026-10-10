# Executor Clones And List-First Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship release 1 of ADR 0033: a roster slot is a clone with a number, every running agent is one line in the watch dashboard with one detail box for the selected one, tasks and board moves are typed events, a `boards` view mode exists, sub-agents the harnesses spawn are observed as children of their lane, and pi's richer events reach the tree.

**Architecture:** The roster allocates clone numbers under its existing lock and publishes them on the lease events it already emits. Three new flow events (`TasksPlanned`, `TaskStarted`, `TaskCompleted`) come from the plan loop, one (`StoryStatusChanged`) from a decorator over `BoardSync`. Connectors carry a `parent` id and a `delegate` category through the existing `LlmChunk` metadata and `ToolUse` seams. The agent tree stays one pure `reduce`/`view` pair; only `mainOf` changes shape, and goldens are regenerated through an `UPDATE_GOLDENS` switch in the existing test.

**Tech Stack:** TypeScript, Effect 4.0.0 (exact pin), `effect/Schema`, `@effect/vitest`. No new dependencies.

**Spec:** `docs/adr/0033-executor-clones-and-list-first-dashboard.md` (decisions), amending `docs/adr/0019-executor-roster.md` and `docs/adr/0022-agent-tree-dashboard.md`.

## Global Constraints

- `effect` and every `@effect/*` package stay pinned at exactly `4.0.0`; no new runtime dependency anywhere.
- Relative imports use `.ts` extensions; no `any`, no unchecked assertions, no namespaces, no unmanaged promises.
- Every new event is a `Schema.TaggedClass` appended to the `FlowEvent` union in `packages/flow/src/FlowEvents.ts:372-399`; the trace keeps `schemaVersion: 1`; older readers skip unknown kinds (they decode with `Schema.decodeUnknownOption`).
- `terminalLine` in `packages/runner/src/Terminal.ts:241` is an exhaustive switch with no default: every new event kind gets a case there or `pnpm typecheck` fails.
- `stamped` in `packages/flow/src/FlowEvents.ts:435-516` rebuilds `ToolUse`, `Info`, `TokensUsed`, `UsageProgress` and the stage events field by field: every new optional field on those, and every new lane-carrying event, needs a case there or the field or lane is dropped.
- Independence stays at the executor level (ADR 0019 decision 2): `avoid` lists keep using `ExecutorSpec.id`, never a clone.
- `executor` on events stays the executor id. The clone number is a separate optional `clone: Schema.Int` field; the dashboard joins them as `codex#2`.
- The classic terminal surface stays the default and prints the same lines it does today, except `rosterEventMessage` now names the clone.
- Tests are deterministic `@effect/vitest` tests; no network, no provider, no installed CLI. Goldens are regenerated only with `UPDATE_GOLDENS=1` and reviewed by eye before commit.
- Verification before every commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Package versions move to `2.41.0` only in the final task, via `pnpm version:set 2.41.0`.

## Review Focus

1. A roster with `slots: 3`, roles `coder` and `judge`, and no `coderSlots`: three coders may be held at once (before: two). Pinned in Task 1.
2. A resumed story whose coder was released and leased again must get the lowest free clone number, and two concurrent coders on one executor must never share a number. Pinned in Task 1.
3. A trace written by 2.40.x (no `clone`, no task events, no `StoryStatusChanged`) must still render: lanes, chips, executor names without `#n`, a detail box with no checklist. Pinned in Task 8 (the existing fixture trace is such a trace).
4. A story plan whose task description has no `Satisfies:` line, or `Satisfies: 2, 3`, or `Satisfies: n/a`: `satisfies` is absent, `[2, 3]`, absent. Pinned in Task 3.
5. A Claude stream where a sub-agent's `tool_use` arrives before any `Agent` call was seen (an older CLI without `parent_tool_use_id`, or a `--bare` run): the tool must land on the lane as today, never on a phantom child. Pinned in Task 7.

## File structure

| Path                                                                   | Responsibility                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/flow/src/Roster.ts` (modify)                                 | `coderSlotsOf` default, clone allocation in `attempt`/`release`, `Lease.clone`, clone on lease events                                                                                                      |
| `packages/flow/src/FlowEvents.ts` (modify)                             | `clone` on `ExecutorLeased`/`ExecutorReleased`/`TokensUsed`, `parent` on `ToolUse`, `TasksPlanned`/`TaskStarted`/`TaskCompleted`/`StoryStatusChanged`, `Lane.clone`, `stamped` cases, `rosterEventMessage` |
| `packages/flow/src/RosterSeats.ts` (modify)                            | `HeldCoder.clone`                                                                                                                                                                                          |
| `packages/runner/src/FlowRunner.ts` (modify)                           | passes `clone` into `withLane`                                                                                                                                                                             |
| `packages/flow/src/CostReport.ts` (modify)                             | `executor`/`clone` on `UsageSample`, `byExecutor` in the report (schema 3)                                                                                                                                 |
| `packages/flow/src/Transcript.ts` (modify)                             | `clone` on a `Call`                                                                                                                                                                                        |
| `packages/flow/src/PlanExecution.ts` (modify)                          | publishes the three task events; `satisfiesOf`                                                                                                                                                             |
| `packages/flow/src/BoardSync.ts` (modify)                              | `eventedBoard` decorator                                                                                                                                                                                   |
| `packages/flow/src/Stories.ts` (modify)                                | wraps `options.board` with `eventedBoard`                                                                                                                                                                  |
| `packages/flow/src/Activity.ts` (modify)                               | `parent` in `toolUseFrom`, `delegate` category, status chunks → `Began`/`Timed` waits, harness tool durations                                                                                              |
| `packages/core/src/providers/CliSupport.ts` (modify)                   | `parent`/`duration` on `toolEventChunk`/`toolResultChunk`, `statusChunk`                                                                                                                                   |
| `packages/core/src/providers/ClaudeCliConnector.ts` (modify)           | `parent_tool_use_id`; usage summed from `modelUsage`                                                                                                                                                       |
| `packages/core/src/providers/CodexConnector.ts` (modify)               | `collab_tool_call` items                                                                                                                                                                                   |
| `packages/core/src/providers/PiConnector.ts` (modify)                  | `aborted`, `durationMs`, `parentToolCallId`, retry and compaction status                                                                                                                                   |
| `packages/runner/src/Terminal.ts` (modify)                             | silent cases for the new kinds                                                                                                                                                                             |
| `packages/runner/src/AgentTree.ts` (modify)                            | reducer: clones, tasks, children, stories, borrowed judge; view: list, detail box, boards, scroll, keys                                                                                                    |
| `packages/runner/test/AgentTree.test.ts` (modify)                      | `UPDATE_GOLDENS`, new goldens, list/detail/boards tests                                                                                                                                                    |
| `packages/runner/test/fixtures/agent-tree.*` (modify/create)           | regenerated goldens, a second trace with clones, tasks, children                                                                                                                                           |
| `docs/observability.md`, `CHANGELOG.md`, `docs/adr/0033-*.md` (modify) | docs, release notes, status Accepted                                                                                                                                                                       |

---

### Task 1: A slot is a clone

**Files:**

- Modify: `packages/flow/src/Roster.ts:116-126` (`coderSlotsOf`), `:417-426` (`Lease`), `:520-536` (usage), `:614-627` (`release`), `:629-652` (`leaseOf`), `:684-715` (`attempt`), `:849-959` (`lease`)
- Modify: `packages/flow/src/FlowEvents.ts:273-294` (`ExecutorLeased`, `ExecutorReleased`), `:338-370` (`rosterEventMessage`)
- Modify: `packages/flow/src/RosterSeats.ts:258-263` (`HeldCoder`), `:299-320` (`acquire`)
- Test: `packages/flow/test/Roster.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `Lease.clone: number | undefined` (undefined when borrowed); `ExecutorLeased.clone?: number`, `ExecutorReleased.clone?: number`; `HeldCoder.clone: Effect.Effect<number | undefined>`; `cloneName(executor: string, clone: number | undefined): string` exported from `FlowEvents.ts` (returns `codex#2` or `codex`).

- [ ] **Step 1: Write the failing tests**

Open `packages/flow/test/Roster.test.ts`, find how existing tests build a roster (look for `makeRoster(` and the `ExecutorSpec.make({ id: ..., harness: ..., roles: [...] })` calls) and the events sink they use (a `makeFlowEventHub` or a recording `FlowEventsShape`). Add inside the main `describe`:

```ts
it.effect(
  "coderSlots defaults to slots, so an executor with a judge role keeps every clone for coders",
  () =>
    Effect.gen(function* () {
      const spec = ExecutorSpec.make({
        id: "codex",
        harness: "codex",
        roles: ["coder", "judge"],
        slots: 3
      })
      assert.strictEqual(coderSlotsOf(spec), 3)
      assert.strictEqual(coderSlotsOf(ExecutorSpec.make({ ...spec, coderSlots: 2 })), 2)
    })
)

it.effect(
  "numbers clones from 1, reuses the lowest free number, and publishes it on lease and release",
  () =>
    Effect.gen(function* () {
      const seen: Array<FlowEvent> = []
      const events: FlowEventsShape = {
        publish: (event) => Effect.sync(() => void seen.push(event))
      }
      const roster = yield* makeRoster(
        [ExecutorSpec.make({ id: "codex", harness: "codex", roles: ["coder"], slots: 3 })],
        { events }
      )
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* roster.lease("coder", { label: "S01" })
          const b = yield* roster.lease("coder", { label: "S02" })
          assert.strictEqual(a.clone, 1)
          assert.strictEqual(b.clone, 2)
          yield* a.release
          const c = yield* roster.lease("coder", { label: "S03" })
          assert.strictEqual(c.clone, 1)
          return c
        })
      )
      assert.strictEqual(first.clone, 1)
      const leased = seen.filter(
        (event): event is ExecutorLeased => event._tag === "ExecutorLeased"
      )
      assert.deepStrictEqual(
        leased.map((event) => event.clone),
        [1, 2, 1]
      )
      const released = seen.filter(
        (event): event is ExecutorReleased => event._tag === "ExecutorReleased"
      )
      assert.deepStrictEqual(
        released.map((event) => event.clone),
        [1, 2, 1]
      )
    })
)

it("names a clone in the roster log line", () => {
  assert.strictEqual(cloneName("codex", 2), "codex#2")
  assert.strictEqual(cloneName("codex", undefined), "codex")
  assert.strictEqual(
    rosterEventMessage(
      ExecutorLeased.make({ executor: "codex", role: "coder", label: "S01", clone: 2 })
    ),
    "roster: codex#2 takes coder · S01"
  )
})
```

Add the imports the file lacks: `coderSlotsOf`, `makeRoster`, `ExecutorSpec` from `@llm4ts/flow/Roster`; `cloneName`, `rosterEventMessage`, `ExecutorLeased`, `ExecutorReleased`, type `FlowEvent`, type `FlowEventsShape` from `@llm4ts/flow/FlowEvents`. If `makeRoster`'s options have another name for the events sink, use it (read `Roster.ts:525-530`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/Roster.test.ts`
Expected: three failures. The first fails with `expected 2 to equal 3`, the second with a type error or `expected undefined to equal 1`, the third with `cloneName is not a function`.

- [ ] **Step 3: Implement the roster side**

In `packages/flow/src/Roster.ts`:

Replace `coderSlotsOf` (116-126) with:

```ts
/** Slots coders may hold: every clone, unless the roster sets `coderSlots` lower (ADR 0033). */
export const coderSlotsOf = (spec: ExecutorSpec): number => {
  const slots = slotsOf(spec)
  return spec.coderSlots === undefined
    ? slots
    : Math.max(0, Math.min(slots, Math.floor(spec.coderSlots)))
}
```

Delete `reasoningRoles` (108) if nothing else references it (`grep -n reasoningRoles packages/flow/src/Roster.ts`); update the doc comment on `coderSlots` (58-59) to `/** Slots coders may use; default: every slot. */`.

Extend `Lease` (417-426) with:

```ts
  /** Which of the executor's clones this is, from 1; absent on a borrowed lease. */
  readonly clone: number | undefined
```

Next to `usage` (530-532) add the clone bookkeeping:

```ts
/** Clone numbers in use per executor; a lease takes the lowest free one. */
const clones = new Map<string, Set<number>>(executors.map((spec) => [spec.id, new Set<number>()]))
const takeClone = (spec: ExecutorSpec): number => {
  const used = clones.get(spec.id) ?? new Set<number>()
  let clone = 1
  while (used.has(clone)) {
    clone += 1
  }
  used.add(clone)
  clones.set(spec.id, used)
  return clone
}
const freeClone = (spec: ExecutorSpec, clone: number | undefined): void => {
  if (clone !== undefined) {
    clones.get(spec.id)?.delete(clone)
  }
}
```

In `attempt` (684-715), inside the locked `Effect.sync`, after `used.busy += 1` and the coder increment, take the clone and return it: change the sync's return to `{ spec, clone: spec === undefined ? undefined : takeClone(spec), back }` and `attempt`'s declared result to `Effect.Effect<{ readonly spec: ExecutorSpec; readonly clone: number } | undefined>` (return `undefined` when `spec` is undefined, else `{ spec, clone }`). Update every caller of `attempt` in `lease` and `takeOwn` (849-959) to destructure `{ spec, clone }` and pass `clone` into `leaseOf`.

Change `release` (614-627) to `release(spec, role, clone)` and call `freeClone(spec, clone)` inside the same `lock.withPermit` block that decrements `busy`.

Change `leaseOf` (629-652) to take `clone: number` after `role`, publish `ExecutorLeased.make({ executor: spec.id, role, clone, ...labelled, ...purposeOf(who), ...own })`, release with `release(spec, role, clone)` and publish `ExecutorReleased.make({ executor: spec.id, role, clone, ...labelled })`, and return `{ executor: spec, role, clone, release: free, borrowed: false, ...own }`.

In `borrowedLease` (655-681) return `clone: undefined` and publish no `clone`.

- [ ] **Step 4: Implement the event side**

In `packages/flow/src/FlowEvents.ts` add to `ExecutorLeased` (273-288) and `ExecutorReleased` (290-294):

```ts
  /** Which of the executor's clones took the slot, from 1 (ADR 0033); absent when borrowed or before 2.41. */
  clone: Schema.optionalKey(Schema.Int),
```

Add, above `rosterEventMessage`:

```ts
/** `codex#2` for a numbered clone, the bare executor otherwise. */
export const cloneName = (executor: string, clone: number | undefined): string =>
  clone === undefined ? executor : `${executor}#${clone}`
```

In `rosterEventMessage` (341-357) replace `${event.executor}` in the `ExecutorLeased` branch with `${cloneName(event.executor, event.clone)}`.

In `packages/flow/src/RosterSeats.ts` add to `HeldCoder` (258-263):

```ts
  /** The held coder's clone number, when it holds a slot. */
  readonly clone: Effect.Effect<number | undefined>
```

and implement it next to `executor` (search `executor: Effect.map(` or the equivalent in `makeHeldCoder`): `clone: Effect.map(Ref.get(current), (held) => held?.lease.clone)` using the same `current` ref `executor` reads.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/flow/test/Roster.test.ts packages/flow/test/RosterSeats.test.ts packages/runner/test/ExecutorRoster.test.ts`
Expected: PASS. Then `pnpm typecheck`: any caller of `release`/`attempt`/`leaseOf` you missed shows up here; fix each by threading `clone`.

- [ ] **Step 6: Commit**

```bash
git add packages/flow/src/Roster.ts packages/flow/src/FlowEvents.ts packages/flow/src/RosterSeats.ts packages/flow/test/Roster.test.ts
git commit -m "flow: a roster slot is a numbered clone; coderSlots defaults to slots (ADR 0033)"
```

---

### Task 2: The clone reaches lane events, the ledger and transcripts

**Files:**

- Modify: `packages/flow/src/FlowEvents.ts:105-113` (`TokensUsed`), `:414-424` (`Lane`), `:484-489` (`stamped` TokensUsed)
- Modify: `packages/runner/src/FlowRunner.ts:799-823` (per-story `withLane`)
- Modify: `packages/flow/src/CostReport.ts:23-35` (`UsageSample`), `:90-108` (`CostReport`, schema), `:119-149` (`usageSamplesFromTrace`), `:252-352` (`buildCostReport`), `:420` (render)
- Modify: `packages/flow/src/Transcript.ts:20-30` (`Call`), `:110-126`
- Test: `packages/flow/test/CostReport.test.ts`, `packages/flow/test/Transcript.test.ts`

**Interfaces:**

- Consumes: `HeldCoder.clone` (Task 1), `cloneName` (Task 1).
- Produces: `TokensUsed.clone?: number`; `Lane.clone?: Effect.Effect<number | undefined>`; `UsageSample.executor?: string`, `UsageSample.clone?: number`; `CostReport.byExecutor: ReadonlyArray<ExecutorUsage>` with `ExecutorUsage = { executor: string; prompt; completion; total; costUsd; estimated }`; `CurrentCostReportSchema = 3`; `TranscriptOptions.clone?: Effect.Effect<number | undefined>` and `Call.clone?: number`.

- [ ] **Step 1: Write the failing tests**

In `packages/flow/test/CostReport.test.ts`, next to the existing `usageSamplesFromTrace` test (find `usageSamplesFromTrace(`), add:

```ts
it("keeps the executor and clone of a lane's usage and groups cost by clone", () => {
  const line = (event: TokensUsed): TraceLine =>
    TraceLine.make({
      schemaVersion: 1,
      seq: 1,
      timestamp: 1_790_000_000_000,
      runId: "run",
      kind: "TokensUsed",
      fields: { event: JSON.stringify(event) }
    })
  const usage = TokenUsage.make({ prompt: 100, completion: 50, total: 150 })
  const samples = usageSamplesFromTrace([
    line(
      TokensUsed.make({
        agent: "coder",
        model: "gpt-5",
        usage,
        lane: "S01",
        executor: "codex",
        clone: 2
      })
    ),
    line(
      TokensUsed.make({
        agent: "coder",
        model: "gpt-5",
        usage,
        lane: "S02",
        executor: "codex",
        clone: 1
      })
    ),
    line(TokensUsed.make({ agent: "judge", model: "gpt-5", usage }))
  ])
  assert.deepStrictEqual(
    samples.map((sample) => [sample.executor, sample.clone]),
    [
      ["codex", 2],
      ["codex", 1],
      [undefined, undefined]
    ]
  )
  const report = buildCostReport(samples, { pricing: [] })
  assert.strictEqual(report.schemaVersion, 3)
  assert.deepStrictEqual(
    report.byExecutor.map((row) => [row.executor, row.total]),
    [
      ["codex#1", 150],
      ["codex#2", 150]
    ]
  )
})
```

Match `buildCostReport`'s real second argument to what the file's other tests pass (read them; if it takes a pricing list under another name, use that). Import `TraceLine` from `@llm4ts/flow/FlowRecorder`, `TokensUsed` from `@llm4ts/flow/FlowEvents`, `TokenUsage` from `@llm4ts/core/Models`.

In `packages/flow/test/Transcript.test.ts`, find the test that asserts a `Call` carries `executor` (search `executor:`), copy it, and assert `clone: 2` is written when the options pass `clone: Effect.succeed(2)` and absent when they pass `clone: Effect.succeed(undefined)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/CostReport.test.ts packages/flow/test/Transcript.test.ts`
Expected: FAIL. `clone` is not a known field of `TokensUsed` (a decode or type error), `report.byExecutor` is undefined, and the transcript line has no `clone`.

- [ ] **Step 3: Implement**

`FlowEvents.ts`:

- `TokensUsed` (105-113): add `clone: Schema.optionalKey(Schema.Int)` after `executor`.
- `Lane` (414-424): add `readonly clone?: Effect.Effect<number | undefined>` with the comment `/** The coder's clone number, read at every publish, as `executor` is. */`.
- `withLane` (the function that calls `stamped`; read it just below `Lane`): read `clone` the way it reads `executor` and pass it to `stamped` as a fifth argument `clone: number | undefined`.
- `stamped`: build `const tags = { lane, ...(executor === undefined ? {} : { executor }) }` as today and a second `const usageTags = { ...tags, ...(clone === undefined ? {} : { clone }) }`; use `usageTags` in the `TokensUsed` case (484-489) instead of `tags`.

`FlowRunner.ts:799-823`: where the per-story `withLane(events, { lane: label, executor: Effect.flatten(Ref.get(executorRef)), workDir })` is built, the held coder does not exist yet (the lane is built first, then `makeHeldCoder`). Add a second ref next to `executorRef`: `const cloneRef = yield* Ref.make<Effect.Effect<number | undefined>>(Effect.succeed(undefined))`, pass `clone: Effect.flatten(Ref.get(cloneRef))` into `withLane`, and after `Ref.set(executorRef, storyCoder.executor)` add `yield* Ref.set(cloneRef, storyCoder.clone)`.

`CostReport.ts`:

- `UsageSample` (23-35): add `executor: Schema.optionalKey(Schema.String)` and `clone: Schema.optionalKey(Schema.Int)`.
- `usageSamplesFromTrace` (138-148): copy `event.executor` and `event.clone` when present.
- Add after `AgentUsage`:

```ts
export class ExecutorUsage extends Schema.Class<ExecutorUsage>("ExecutorUsage")({
  /** `codex#2`, or the bare executor when the usage carried no clone. */
  executor: Schema.String,
  prompt: Schema.Int,
  completion: Schema.Int,
  total: Schema.Int,
  costUsd: Schema.Number,
  estimated: Schema.Boolean
}) {}
```

- `CostReport` (90-105): add `byExecutor: Schema.Array(ExecutorUsage)`; set `CurrentCostReportSchema = 3`.
- `buildCostReport`: group samples that have an `executor` by `cloneName(sample.executor, sample.clone)` (import from `./FlowEvents.ts`), sum like `byAgent` does (copy the `byAgentGroups` block at 305-320 and adapt), sort by key, and put `byExecutor` in the result. Samples without an executor are not in the table.
- Render (around 420): after the `byAgent` table, when `report.byExecutor.length > 0`, print an `executors` table with the same columns as agents.

`Transcript.ts`: add `clone: Schema.optionalKey(Schema.Int)` to `Call` after `executor`; add `readonly clone?: Effect.Effect<number | undefined>` to the options type that holds `executor`; in the write at 117-123 add `const clone = options.clone === undefined ? undefined : yield* options.clone` and `...(clone === undefined ? {} : { clone })`. Wire it where `executor: storyCoder.executor` is passed to the transcript (grep `executor: ` in `FlowRunner.ts` near the transcript setup) as `clone: storyCoder.clone`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/flow/test/CostReport.test.ts packages/flow/test/Transcript.test.ts packages/runner/test/Costs.test.ts && pnpm typecheck`
Expected: PASS. If a runner `Costs.test.ts` fixture asserts `schemaVersion: 2`, update it to 3.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/FlowEvents.ts packages/flow/src/CostReport.ts packages/flow/src/Transcript.ts packages/runner/src/FlowRunner.ts packages/flow/test packages/runner/test
git commit -m "flow: the coder's clone is on lane usage, the cost ledger and transcripts (ADR 0033)"
```

---

### Task 3: Tasks are events

**Files:**

- Modify: `packages/flow/src/FlowEvents.ts` (three new events, union, `stamped`)
- Modify: `packages/flow/src/PlanExecution.ts:38-56`
- Modify: `packages/runner/src/Terminal.ts:40-46`, `:248-253`, `:547-555`
- Test: `packages/flow/test/PlanExecution.test.ts`

**Interfaces:**

- Produces:

```ts
export class TasksPlanned extends Schema.TaggedClass<TasksPlanned>()("TasksPlanned", {
  tasks: Schema.Array(Schema.Struct({ title: Schema.String, completed: Schema.Boolean, satisfies: Schema.optionalKey(Schema.Array(Schema.Int)) })),
  lane: Schema.optionalKey(Schema.String),
  executor: Schema.optionalKey(Schema.String)
}) {}
export class TaskStarted extends Schema.TaggedClass<TaskStarted>()("TaskStarted", {
  index: Schema.Int, count: Schema.Int, title: Schema.String,
  satisfies: Schema.optionalKey(Schema.Array(Schema.Int)),
  lane: Schema.optionalKey(Schema.String), executor: Schema.optionalKey(Schema.String)
}) {}
export class TaskCompleted extends Schema.TaggedClass<TaskCompleted>()("TaskCompleted", {
  index: Schema.Int, count: Schema.Int, title: Schema.String,
  lane: Schema.optionalKey(Schema.String), executor: Schema.optionalKey(Schema.String)
}) {}
export const satisfiesOf = (description: string): ReadonlyArray<number> | undefined
```

`index` is 1-based and is the task's position in `plan.tasks`, so a resumed plan reports `task 3/5` for its first unfinished task.

- [ ] **Step 1: Write the failing tests**

In `packages/flow/test/PlanExecution.test.ts`, read how the existing tests build a `Plan`, a `PlanStoreShape` (probably `makeMemoryPlainFileStore` plus a plan store) and an events sink; then add:

```ts
it("reads the criteria a task satisfies from its description", () => {
  assert.deepStrictEqual(satisfiesOf("Add the route.\nSatisfies: 2"), [2])
  assert.deepStrictEqual(satisfiesOf("Tests.\n\nSatisfies: 1, 3"), [1, 3])
  assert.isUndefined(satisfiesOf("No criteria here"))
  assert.isUndefined(satisfiesOf("Satisfies: n/a"))
})

it.effect("announces the plan, then each unfinished task's start and end, in plan order", () =>
  Effect.gen(function* () {
    const seen: Array<FlowEvent> = []
    const events: FlowEventsShape = { publish: (event) => Effect.sync(() => void seen.push(event)) }
    const plan = Plan.make({
      epicId: "S01",
      tasks: [
        Task.make({ title: "route", description: "Satisfies: 1", completed: true }),
        Task.make({ title: "cookie", description: "Satisfies: 2" }),
        Task.make({ title: "docs", description: "" })
      ]
    })
    const store = yield* memoryPlanStore() // whatever helper the file already uses
    yield* implementTaskLoop(store, events, "plan.md", plan, () => Effect.void)
    const kinds = seen.map((event) =>
      event._tag === "TaskStarted" || event._tag === "TaskCompleted"
        ? `${event._tag} ${event.index}/${event.count} ${event.title}`
        : event._tag
    )
    assert.deepStrictEqual(kinds, [
      "TasksPlanned",
      "TaskStarted 2/3 cookie",
      "StageStarted",
      "StageCompleted",
      "TaskCompleted 2/3 cookie",
      "TaskStarted 3/3 docs",
      "StageStarted",
      "StageCompleted",
      "TaskCompleted 3/3 docs"
    ])
    const planned = seen[0]
    assert.strictEqual(planned?._tag, "TasksPlanned")
    if (planned?._tag === "TasksPlanned") {
      assert.deepStrictEqual(
        planned.tasks.map((task) => [task.title, task.completed, task.satisfies]),
        [
          ["route", true, [1]],
          ["cookie", false, [2]],
          ["docs", false, undefined]
        ]
      )
    }
    const started = seen.find((event): event is TaskStarted => event._tag === "TaskStarted")
    assert.deepStrictEqual(started?.satisfies, [2])
  })
)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/PlanExecution.test.ts`
Expected: FAIL with `satisfiesOf is not a function` and, for the second, the kinds list holding only `StageStarted`/`StageCompleted`.

- [ ] **Step 3: Implement**

`FlowEvents.ts`: add the three classes from the Interfaces block next to `StoryJudged`, append them to the `FlowEvent` union, and add `stamped` cases that stamp `lane`/`executor` the way `StageStarted` does:

```ts
    case "TasksPlanned":
      return event.lane !== undefined ? event : TasksPlanned.make({ tasks: event.tasks, ...tags })
    case "TaskStarted":
      return event.lane !== undefined
        ? event
        : TaskStarted.make({
            index: event.index,
            count: event.count,
            title: event.title,
            ...(event.satisfies === undefined ? {} : { satisfies: event.satisfies }),
            ...tags
          })
    case "TaskCompleted":
      return event.lane !== undefined
        ? event
        : TaskCompleted.make({ index: event.index, count: event.count, title: event.title, ...tags })
```

`PlanExecution.ts`: add

```ts
/** The acceptance criteria a task's description names: `Satisfies: 1, 3` → `[1, 3]`. */
export const satisfiesOf = (description: string): ReadonlyArray<number> | undefined => {
  const match = /^\s*Satisfies:\s*(.+)$/imu.exec(description)
  if (match === null) {
    return undefined
  }
  const numbers = (match[1] ?? "")
    .split(/[,\s]+/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((number) => Number.isInteger(number) && number > 0)
  return numbers.length === 0 ? undefined : numbers
}
```

and rewrite `implementTaskLoop`'s body:

```ts
let current = plan
const count = plan.tasks.length
yield *
  events.publish(
    TasksPlanned.make({
      tasks: plan.tasks.map((task) => ({
        title: task.title,
        completed: task.completed,
        ...(satisfiesOf(task.description) === undefined
          ? {}
          : { satisfies: satisfiesOf(task.description) })
      }))
    })
  )
for (const [position, task] of plan.tasks.entries()) {
  if (!task.completed) {
    const index = position + 1
    const satisfies = satisfiesOf(task.description)
    yield *
      events.publish(
        TaskStarted.make({
          index,
          count,
          title: task.title,
          ...(satisfies === undefined ? {} : { satisfies })
        })
      )
    yield * stage(events, task.title, perTask(task, current))
    current = current.complete(task.title)
    yield * store.save(planPath, current)
    yield * events.publish(TaskCompleted.make({ index, count, title: task.title }))
  }
}
return current
```

(Write the `satisfies` spread once with a local, not two calls, in the `TasksPlanned` map.)

`Terminal.ts`: add `"TasksPlanned" | "TaskStarted" | "TaskCompleted"` to the `return false` group of `rendersEvent` (40-46), to the `return ""` group of `terminalLine` (248-253), and to the lane-carrying list in `laneOfEvent` (547-555).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/flow/test/PlanExecution.test.ts packages/runner/test/Terminal.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/FlowEvents.ts packages/flow/src/PlanExecution.ts packages/runner/src/Terminal.ts packages/flow/test/PlanExecution.test.ts
git commit -m "flow: the task loop publishes TasksPlanned, TaskStarted and TaskCompleted (ADR 0033)"
```

---

### Task 4: Board moves are events

**Files:**

- Modify: `packages/flow/src/FlowEvents.ts` (`StoryStatusChanged`, union; no `stamped` case: it carries no lane)
- Modify: `packages/flow/src/BoardSync.ts` (`eventedBoard`)
- Modify: `packages/flow/src/Stories.ts:876-877` (wrap the board)
- Modify: `packages/runner/src/Terminal.ts:40-46`, `:248-253`
- Test: `packages/flow/test/BoardSync.test.ts`

**Interfaces:**

- Produces:

```ts
export class StoryStatusChanged extends Schema.TaggedClass<StoryStatusChanged>()("StoryStatusChanged", {
  id: Schema.String,
  status: Schema.Literals(["planned", "active", "waiting", "done", "failed", "skipped"])
}) {}
export const eventedBoard = (board: BoardSyncShape, events: FlowEventsShape): BoardSyncShape
```

- [ ] **Step 1: Write the failing test**

In `packages/flow/test/BoardSync.test.ts`, after the local board tests, add:

```ts
it.effect("publishes StoryStatusChanged for every move, including the plan", () =>
  Effect.gen(function* () {
    const seen: Array<FlowEvent> = []
    const events: FlowEventsShape = { publish: (event) => Effect.sync(() => void seen.push(event)) }
    const files = yield* makeMemoryPlainFileStore()
    const board = eventedBoard(makeLocalBoardSync(files, ".llm4ts/epics/e1", "Epic: e1"), events)
    yield* board.plan([
      BoardItem.make({ id: "S01", title: "login", status: "planned" }),
      BoardItem.make({ id: "S02", title: "reset", status: "planned" })
    ])
    yield* board.start("S01")
    yield* board.wait("S02", "depends on S01")
    yield* board.complete("S01", {})
    yield* board.fail("S02", "red")
    yield* board.skip("S02", "dropped")
    assert.deepStrictEqual(
      seen.map((event) =>
        event._tag === "StoryStatusChanged" ? `${event.id}:${event.status}` : event._tag
      ),
      [
        "S01:planned",
        "S02:planned",
        "S01:active",
        "S02:waiting",
        "S01:done",
        "S02:failed",
        "S02:skipped"
      ]
    )
    const snapshot = yield* board.snapshot
    assert.strictEqual(snapshot.items.find((item) => item.id === "S01")?.status, "done")
  })
)
```

Use the file's existing way of making an in-memory file store if it differs from `makeMemoryPlainFileStore()`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/flow/test/BoardSync.test.ts`
Expected: FAIL with `eventedBoard is not a function`.

- [ ] **Step 3: Implement**

`FlowEvents.ts`: add `StoryStatusChanged` (reuse the status literal list; if `BoardStatus` cannot be imported without a cycle, inline the literals) and append it to the union.

`BoardSync.ts`:

```ts
import { StoryStatusChanged, type FlowEventsShape } from "./FlowEvents.ts"

/** A board whose every move is also a `StoryStatusChanged` event, so the trace carries the board (ADR 0033). */
export const eventedBoard = (board: BoardSyncShape, events: FlowEventsShape): BoardSyncShape => {
  const moved = (id: string, status: BoardStatus) =>
    events.publish(StoryStatusChanged.make({ id, status }))
  return {
    plan: (items) =>
      Effect.andThen(
        board.plan(items),
        Effect.forEach(items, (item) => moved(item.id, item.status), { discard: true })
      ),
    start: (id) => Effect.andThen(board.start(id), moved(id, "active")),
    complete: (id, result) => Effect.andThen(board.complete(id, result), moved(id, "done")),
    fail: (id, reason) => Effect.andThen(board.fail(id, reason), moved(id, "failed")),
    skip: (id, reason) => Effect.andThen(board.skip(id, reason), moved(id, "skipped")),
    wait: (id, reason) => Effect.andThen(board.wait(id, reason), moved(id, "waiting")),
    snapshot: board.snapshot
  }
}
```

`BoardStatus` is a schema; use `typeof BoardStatus.Type` for the parameter type (define `type BoardStatus = typeof BoardStatus.Type` if the file has none).

`Stories.ts:876-877`: change `const { files, board } = options` to `const { files } = options` and `const board = eventedBoard(options.board, context.events)` after `const events = context.events` (keep whichever name the file uses for the root events).

`Terminal.ts`: add `"StoryStatusChanged"` to the `return false` group (40-46) and the `return ""` group (248-253).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/flow/test/BoardSync.test.ts packages/flow/test/Stories.test.ts && pnpm typecheck`
Expected: PASS. A Stories test that counts every published event by kind may now see `StoryStatusChanged` lines; if one asserts an exact list, add the new entries at the positions the board moves happen.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/FlowEvents.ts packages/flow/src/BoardSync.ts packages/flow/src/Stories.ts packages/runner/src/Terminal.ts packages/flow/test
git commit -m "flow: every board move is a StoryStatusChanged event (ADR 0033)"
```

---

### Task 5: Sub-agents are observed: parent ids and the delegate category

**Files:**

- Modify: `packages/core/src/providers/CliSupport.ts:78-132`
- Modify: `packages/core/src/providers/ClaudeCliConnector.ts:90-167`
- Modify: `packages/core/src/providers/CodexConnector.ts:91-175`
- Modify: `packages/flow/src/FlowEvents.ts:88-95` (`ToolUse.parent`), `:453-460` (`stamped` ToolUse)
- Modify: `packages/flow/src/Activity.ts:100-112` (`toolUseFrom`), `:133-177` (`toolCategory`)
- Test: `packages/core/test/CliSupport.test.ts`, `packages/core/test/ClaudeCliConnector.test.ts`, `packages/core/test/CodexConnector.test.ts`, `packages/flow/test/Activity.test.ts`

**Interfaces:**

- Produces: `toolEventChunk(name, input, id?, options?: { readonly parent?: string })`; `toolResultChunk(id, options & { readonly parent?: string; readonly durationMs?: number })` setting `metadata.parent` and `metadata.tool_duration_ms`; `ToolUse.parent?: string`; `ToolCategory` gains `"delegate"`; `delegateTools` regex exported from `Activity.ts`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/CliSupport.test.ts`:

```ts
it("carries a parent tool id and a harness-reported duration on tool chunks", () => {
  assert.strictEqual(
    toolEventChunk("Read", { path: "a" }, "t2", { parent: "t1" }).metadata.parent,
    "t1"
  )
  assert.isUndefined(toolEventChunk("Read", { path: "a" }, "t2").metadata.parent)
  const ended = toolResultChunk("t2", { parent: "t1", durationMs: 420 }).metadata
  assert.strictEqual(ended.parent, "t1")
  assert.strictEqual(ended.tool_duration_ms, "420")
})
```

`packages/core/test/ClaudeCliConnector.test.ts` (next to the existing `parseClaudeCliStreamLine` tests):

```ts
it("marks a sub-agent's tool calls with the Agent call that spawned them", () => {
  const spawn = parseClaudeCliStreamLine(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a1","name":"Agent","input":{"subagent_type":"Explore","prompt":"find x"}}]}}'
  )[0]
  assert.strictEqual(spawn?.metadata.tool_name, "Agent")
  assert.isUndefined(spawn?.metadata.parent)
  const inner = parseClaudeCliStreamLine(
    '{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"x.ts"}}]}}'
  )[0]
  assert.strictEqual(inner?.metadata.parent, "a1")
  const result = parseClaudeCliStreamLine(
    '{"type":"user","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_result","tool_use_id":"r1","content":"ok"}]}}'
  )[0]
  assert.strictEqual(result?.metadata.parent, "a1")
})

it("sums usage over every model in modelUsage, which includes sub-agents", () => {
  const chunk = parseClaudeCliStreamLine(
    '{"type":"result","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.5,"modelUsage":{"claude-opus-5-5":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":100},"claude-haiku-5-5":{"inputTokens":1000,"outputTokens":200,"cacheReadInputTokens":0}}}'
  )[0]
  assert.deepStrictEqual(
    [chunk?.usage?.prompt, chunk?.usage?.completion, chunk?.usage?.cached, chunk?.usage?.costUsd],
    [1010, 205, 100, 0.5]
  )
  assert.isUndefined(chunk?.metadata.model)
})
```

(The existing single-model test keeps passing: with one entry the sum equals that entry, and `model` is still set when there is exactly one.)

`packages/core/test/CodexConnector.test.ts`:

```ts
it("turns a spawn_agent collab call into a tool call and its completion into the result", () => {
  const started = parseCodexStreamLine(
    '{"type":"item.started","item":{"id":"c1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"t0","receiver_thread_ids":["t1"],"prompt":"write tests","status":"in_progress"}}'
  )[0]
  assert.strictEqual(started?.metadata.event, "tool_use")
  assert.strictEqual(started?.metadata.tool_name, "spawn_agent")
  assert.strictEqual(started?.metadata.tool_id, "c1")
  assert.include(started?.metadata.tool_input ?? "", "write tests")
  const done = parseCodexStreamLine(
    '{"type":"item.completed","item":{"id":"c1","type":"collab_tool_call","tool":"spawn_agent","status":"completed","receiver_thread_ids":["t1"]}}'
  )[0]
  assert.strictEqual(done?.metadata.event, "tool_result")
  assert.strictEqual(done?.metadata.tool_id, "c1")
  const failed = parseCodexStreamLine(
    '{"type":"item.completed","item":{"id":"c2","type":"collab_tool_call","tool":"wait","status":"failed"}}'
  )[0]
  assert.strictEqual(failed?.metadata.tool_failed, "true")
})
```

`packages/flow/test/Activity.test.ts`:

```ts
it("classifies harness delegation as delegate and keeps the parent on a ToolUse", () => {
  assert.strictEqual(toolCategory("Agent", "{}"), "delegate")
  assert.strictEqual(toolCategory("Task", "{}"), "delegate")
  assert.strictEqual(toolCategory("spawn_agent", "{}"), "delegate")
  assert.strictEqual(toolCategory("codebase_investigator", "{}"), "delegate")
  assert.strictEqual(toolCategory("Read", "{}"), "explore")
  const use = toolUseFrom(
    LlmChunk.make({
      delta: "",
      metadata: { event: "tool_use", tool_name: "Read", tool_input: "{}", parent: "a1" }
    })
  )
  assert.strictEqual(use?.parent, "a1")
  const stamped = withLane({ publish: () => Effect.void }, { lane: "S01" })
  // the stamp must keep `parent`: publish through a recording sink instead
})
```

Replace the last two lines with the file's own pattern for asserting what `withLane` publishes (search `withLane(` in the test file): publish a `ToolUse.make({ tool: "Read", args: "{}", parent: "a1" })` through the laned sink and assert the recorded event has `lane: "S01"` and `parent: "a1"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/CliSupport.test.ts packages/core/test/ClaudeCliConnector.test.ts packages/core/test/CodexConnector.test.ts packages/flow/test/Activity.test.ts`
Expected: FAIL on `parent` being undefined, `tool_duration_ms` undefined, the Codex chunk arrays empty, usage `[10, 5, undefined, 0.5]`, and category `other`.

- [ ] **Step 3: Implement**

`CliSupport.ts`:

```ts
export const toolEventChunk = (
  name: string,
  input: JsonValue | undefined,
  id?: string,
  options: { readonly parent?: string } = {}
): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_use",
      tool_name: name,
      tool_input: input === undefined ? "{}" : jsonText(input),
      ...(id === undefined || id.length === 0 ? {} : { tool_id: id }),
      ...(options.parent === undefined || options.parent.length === 0
        ? {}
        : { parent: options.parent })
    }
  })
```

and in `toolResultChunk`'s options add `readonly parent?: string` and `readonly durationMs?: number`, emitting `parent` as above and `...(options.durationMs === undefined ? {} : { tool_duration_ms: String(Math.round(options.durationMs)) })`.

`ClaudeCliConnector.ts`: at the top of `parseClaudeCliStreamLine`'s `assistant`/`user` handling read `const parent = jsonStringField(json, "parent_tool_use_id")` and pass `parent === undefined ? {} : { parent }` as the options of `toolEventChunk` (107) and into `toolResultChunk`'s options (124). In the `result` case, when `modelUsage` is a non-null object, compute:

```ts
const perModel = Object.values(modelUsage).map((entry) => ({
  prompt: jsonIntField(entry, "inputTokens") ?? 0,
  completion: jsonIntField(entry, "outputTokens") ?? 0,
  cached: jsonIntField(entry, "cacheReadInputTokens") ?? 0
}))
```

and use the sums when `perModel.length > 0`, falling back to `usage.input_tokens`/`output_tokens`/`cache_read_input_tokens` otherwise. `jsonIntField(entry, ...)` must accept `JsonValue`; `Object.values` on the narrowed object gives `JsonValue`s. Keep `model` as today (set only when exactly one entry).

`CodexConnector.ts`: in `item.started`, add a branch for `item.type === "collab_tool_call"`: `toolEventChunk(jsonStringField(item, "tool") ?? "collab", { prompt: jsonStringField(item, "prompt") ?? "", receivers: jsonField(item, "receiver_thread_ids") ?? [] }, jsonStringField(item, "id"))`. In `item.completed`, for `collab_tool_call`: `toolResultChunk(jsonStringField(item, "id"), { failed: jsonStringField(item, "status") === "failed", tool: jsonStringField(item, "tool") ?? "collab" })`.

`FlowEvents.ts`: add `parent: Schema.optionalKey(Schema.String)` to `ToolUse` with the comment `/** The tool call this one runs inside, when a harness delegated it to a sub-agent (ADR 0033). */`; in `stamped`'s `ToolUse` case add `...(event.parent === undefined ? {} : { parent: event.parent })`.

`Activity.ts`: in `toolUseFrom` add `const parent = chunk.metadata.parent` and `...(parent === undefined || parent.length === 0 ? {} : { parent })` to the `ToolUse.make`. Extend the category:

```ts
export type ToolCategory =
  | "explore"
  | "edit"
  | "test"
  | "build"
  | "install"
  | "git"
  | "delegate"
  | "other"
/** A harness handing work to a sub-agent: Claude's Agent (Task before 2.1.63), Codex's collab tools, Gemini's agents. */
export const delegateTools =
  /^(agent|task|spawn_agent|send_input|wait_agent|wait|resume_agent|close_agent|codebase_investigator|generalist|cli_help|browser_agent)$/iu
```

and in `toolCategory` test `delegateTools` first, before `editTools`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core packages/flow/test/Activity.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers packages/core/test packages/flow/src/FlowEvents.ts packages/flow/src/Activity.ts packages/flow/test/Activity.test.ts
git commit -m "core/flow: sub-agent tool calls carry their parent; delegation is a tool category (ADR 0033)"
```

---

### Task 6: pi's richer events

**Files:**

- Modify: `packages/core/src/providers/CliSupport.ts` (`statusChunk`)
- Modify: `packages/core/src/providers/PiConnector.ts:83-174`
- Modify: `packages/flow/src/Activity.ts:190-276`
- Test: `packages/core/test/CliConnectorFamilies.test.ts`, `packages/flow/test/Activity.test.ts`

**Interfaces:**

- Produces: `statusChunk(status: "retrying" | "compacting", phase: "start" | "end", detail?: string): LlmChunk` with metadata `{ event: "status", status, phase, status_detail? }`. `withToolActivity` turns a `start` into `Began.make({ kind: "wait", label: "pi retry" | "pi compaction" })` and an `end` into the matching `Timed`. A `tool_result` chunk with `tool_duration_ms` sets `Timed.ms` from it instead of the wall clock.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/CliConnectorFamilies.test.ts`, in the `PiConnector` describe:

```ts
it("maps aborted turns, tool durations, nested calls, retries and compaction", () => {
  assert.strictEqual(
    parsePiStreamLine(
      '{"type":"message_end","message":{"role":"assistant","stopReason":"aborted"}}'
    )[0]?.metadata.piError,
    "pi aborted the turn"
  )
  const ended = parsePiStreamLine(
    '{"type":"tool_execution_end","toolCallId":"t1","durationMs":1234,"result":{"content":[{"type":"text","text":"ok"}]}}'
  )[0]?.metadata
  assert.strictEqual(ended?.tool_duration_ms, "1234")
  const nested = parsePiStreamLine(
    '{"type":"tool_execution_start","toolCallId":"t2","parentToolCallId":"t1","toolName":"read","args":{}}'
  )[0]?.metadata
  assert.strictEqual(nested?.parent, "t1")
  assert.deepStrictEqual(
    parsePiStreamLine(
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"529"}'
    )[0]?.metadata,
    { event: "status", status: "retrying", phase: "start", status_detail: "529" }
  )
  assert.strictEqual(
    parsePiStreamLine('{"type":"auto_retry_end","success":true}')[0]?.metadata.phase,
    "end"
  )
  assert.strictEqual(
    parsePiStreamLine('{"type":"compaction_start"}')[0]?.metadata.status,
    "compacting"
  )
  assert.strictEqual(parsePiStreamLine('{"type":"compaction_end"}')[0]?.metadata.phase, "end")
})
```

(The existing retry test asserts `auto_retry_end` with `success: false` yields `piError`; keep that behavior: a failed retry end is an error, a successful one is a status end.)

`packages/flow/test/Activity.test.ts`, following the file's pattern for feeding chunks through `withToolActivity` and recording events:

```ts
it.effect(
  "turns a harness status into a wait, and takes the tool duration the harness reports",
  () =>
    Effect.gen(function* () {
      const seen = yield* record(
        Stream.make(
          statusChunk("retrying", "start", "529"),
          statusChunk("retrying", "end"),
          toolEventChunk("read", {}, "t1"),
          toolResultChunk("t1", { durationMs: 1234 })
        )
      )
      const began = seen.find((event): event is Began => event._tag === "Began")
      assert.deepStrictEqual([began?.kind, began?.label], ["wait", "pi retry"])
      const waits = seen.filter(
        (event): event is Timed => event._tag === "Timed" && event.kind === "wait"
      )
      assert.strictEqual(waits.length, 1)
      const tool = seen.find(
        (event): event is Timed => event._tag === "Timed" && event.kind === "tool"
      )
      assert.strictEqual(tool?.ms, 1234)
    })
)
```

where `record` is whatever helper the file uses to run `withToolActivity` over a stream and collect the published events (write one if there is none: a `FlowEventsShape` that pushes into an array, `Stream.runDrain(withToolActivity(events, call, stream))`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/CliConnectorFamilies.test.ts packages/flow/test/Activity.test.ts`
Expected: FAIL: `piError` undefined for aborted, `tool_duration_ms` undefined, `parent` undefined, status chunks absent, no `Began`, tool `ms` is the wall clock (0).

- [ ] **Step 3: Implement**

`CliSupport.ts`:

```ts
/** A harness pausing a turn on its own account: a provider retry, a context compaction. */
export const statusChunk = (
  status: "retrying" | "compacting",
  phase: "start" | "end",
  detail?: string
): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: {
      event: "status",
      status,
      phase,
      ...(detail === undefined || detail.length === 0 ? {} : { status_detail: detail })
    }
  })
```

`PiConnector.ts` `parsePiStreamLine`:

- `tool_execution_start`: pass `{ parent: jsonStringField(json, "parentToolCallId") }` (only when defined) as `toolEventChunk`'s options.
- `tool_execution_end`: add `durationMs: jsonIntField(json, "durationMs")` (only when defined) and the same `parent`.
- `message_end`/`agent_end`: before the `error` check, `if (jsonStringField(message, "stopReason") === "aborted") return [LlmChunk.make({ delta: "", metadata: { piError: "pi aborted the turn" } })]`.
- new cases: `auto_retry_start` → `[statusChunk("retrying", "start", jsonStringField(json, "errorMessage"))]`; `auto_retry_end` → `success === false` keeps the `piError` chunk, else `[statusChunk("retrying", "end")]`; `compaction_start` → `[statusChunk("compacting", "start")]`; `compaction_end` → `[statusChunk("compacting", "end")]`.

`Activity.ts` `withToolActivity`:

- Keep a `Ref<ReadonlyArray<{ label: string; at: number }>>` of open waits. On `metadata.event === "status"` with `phase === "start"`, publish `Began.make({ kind: "wait", label })` where `label` is `pi retry` for `retrying` and `pi compaction` for `compacting` (the harness name comes from the `call`/connector id if the file has it; if not, use the literal `pi` since pi is the only emitter), and push `{ label, at: now }`. On `phase === "end"`, pop the matching label and publish `Timed.make({ kind: "wait", label, ms: now - at })`.
- In `toolEnded` (190-222), read `const reported = chunk.metadata.tool_duration_ms` and use `Number(reported)` as `ms` when it parses to a finite non-negative number; otherwise `now - started.at` as today.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/test/CliConnectorFamilies.test.ts packages/flow/test/Activity.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/CliSupport.ts packages/core/src/providers/PiConnector.ts packages/flow/src/Activity.ts packages/core/test packages/flow/test/Activity.test.ts
git commit -m "core/flow: pi retries, compaction, tool durations, nested calls and aborts reach the trace (ADR 0033)"
```

---

### Task 7: The tree reducer learns clones, tasks, children, board moves and borrowed judges

**Files:**

- Modify: `packages/runner/src/AgentTree.ts:27-158` (state types), `:174` (`emptyTree`), `:243-275` (`reduceLease`), `:282-513` (`reduceEvent`)
- Test: `packages/runner/test/AgentTree.test.ts`

**Interfaces:**

- Produces, on `TreeLane`:

```ts
  readonly clone: number | undefined
  /** The plan's tasks, in order, as `TasksPlanned` and the task events reported them. */
  readonly tasks: ReadonlyArray<{ readonly index: number; readonly title: string; readonly done: boolean; readonly satisfies?: ReadonlyArray<number> }>
  /** The running task: index from 1 and the plan's count. */
  readonly task: { readonly index: number; readonly count: number; readonly title: string; readonly satisfies?: ReadonlyArray<number> } | undefined
  /** Sub-agents the harness spawned on this lane (a delegate tool call), newest last. */
  readonly children: ReadonlyArray<TreeChild>
  /** A harness pause under way: `pi retry`, `pi compaction`. */
  readonly pause: { readonly label: string; readonly since: number } | undefined
export interface TreeChild {
  readonly id: string
  readonly tool: string
  readonly args: string
  readonly since: number
  readonly lastTool: string | undefined
  readonly ended: boolean
}
```

`TreeLease.clone: number | undefined`; `TreeJudge.borrowed: number` (how many judge or reviewer leases ran on the story's own executor); `TreeState.lastChanged: string | undefined` (the lane that published last).

- [ ] **Step 1: Write the failing tests**

In `packages/runner/test/AgentTree.test.ts` add, using the file's `at` and `fold` helpers:

```ts
it("puts the coder's clone on its lane and counts a borrowed judge", () => {
  const state = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(1, ExecutorLeased.make({ executor: "codex", role: "coder", label: "S01", clone: 2 })),
    at(
      2,
      ExecutorLeased.make({
        executor: "codex",
        role: "judge",
        label: "S01",
        borrowed: true,
        because: "nobody"
      })
    )
  ])
  assert.strictEqual(state.lanes[0]?.clone, 2)
  assert.strictEqual(state.leases[0]?.clone, 2)
  assert.strictEqual(state.judge.borrowed, 1)
  assert.strictEqual(state.lastChanged, "S01")
})

it("keeps the task checklist, the running task and board moves", () => {
  const state = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(
      1,
      TasksPlanned.make({
        lane: "S01",
        tasks: [
          { title: "route", completed: true, satisfies: [1] },
          { title: "cookie", completed: false, satisfies: [2] }
        ]
      })
    ),
    at(2, TaskStarted.make({ lane: "S01", index: 2, count: 2, title: "cookie", satisfies: [2] })),
    at(3, StoryStatusChanged.make({ id: "S02", status: "waiting" })),
    at(4, TaskCompleted.make({ lane: "S01", index: 2, count: 2, title: "cookie" }))
  ])
  const lane = state.lanes[0]
  assert.deepStrictEqual(
    lane?.tasks.map((task) => [task.index, task.done]),
    [
      [1, true],
      [2, true]
    ]
  )
  assert.isUndefined(lane?.task)
  assert.strictEqual(state.stories.find((story) => story.id === "S02")?.status, "waiting")
  const mid = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(2, TaskStarted.make({ lane: "S01", index: 2, count: 5, title: "cookie", satisfies: [2] }))
  ])
  assert.deepStrictEqual(mid.lanes[0]?.task, {
    index: 2,
    count: 5,
    title: "cookie",
    satisfies: [2]
  })
})

it("nests a harness sub-agent under its lane and keeps a parentless tool on the lane", () => {
  const state = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(1, ToolUse.make({ lane: "S01", tool: "Agent", args: "Explore: find x" })),
    at(2, ToolUse.make({ lane: "S01", tool: "Read", args: "x.ts", parent: "a1" })),
    at(3, ToolUse.make({ lane: "S01", tool: "Edit", args: "y.ts" }))
  ])
  const lane = state.lanes[0]
  assert.strictEqual(lane?.children.length, 1)
  assert.strictEqual(lane?.children[0]?.tool, "Agent")
  assert.strictEqual(lane?.children[0]?.lastTool, "Read x.ts")
  assert.strictEqual(lane?.lastTool, "Edit y.ts")
  const orphan = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(1, ToolUse.make({ lane: "S01", tool: "Read", args: "x.ts", parent: "ghost" }))
  ])
  assert.strictEqual(orphan.lanes[0]?.children.length, 0)
  assert.strictEqual(orphan.lanes[0]?.lastTool, "Read x.ts")
})

it("shows a harness pause as the lane's state while it lasts", () => {
  const paused = fold([
    at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
    at(1, Began.make({ lane: "S01", kind: "wait", label: "pi compaction" }))
  ])
  assert.deepStrictEqual(paused.lanes[0]?.pause, { label: "pi compaction", since: t0 + 1000 })
  const over = fold(
    [at(2, Timed.make({ lane: "S01", kind: "wait", label: "pi compaction", ms: 1000 }))],
    paused
  )
  assert.isUndefined(over.lanes[0]?.pause)
})
```

A `ToolUse` for `Agent` has no `tool_id` in the event (the trace never carried ids), so the child id is the ToolUse's position: use `${lane.id}:${lane.children.length + 1}` as `TreeChild.id` and match a `parent` to the newest child that has not ended. (The `orphan` case has no child, so the tool stays on the lane.) A `Timed{kind:"tool", category:"delegate"}` marks the newest open child `ended`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/runner/test/AgentTree.test.ts`
Expected: the four new tests FAIL (`clone`, `tasks`, `children`, `pause`, `borrowed`, `lastChanged` are undefined or type errors); the existing tests pass.

- [ ] **Step 3: Implement**

In `AgentTree.ts`:

- Add the fields from Interfaces to `TreeLane`, `TreeLease`, `TreeJudge`, `TreeState`; initialise them in `emptyTree` (`lastChanged: undefined`, `judge: { executor: undefined, reviews: 0, verdicts: 0, borrowed: 0 }`) and in the lane creation on `StageStarted "story <id>"` (`clone: undefined, tasks: [], task: undefined, children: [], pause: undefined`).
- In `reduceEvent`, where a laned event touches `lastEventAt` (283-299), also set `lastChanged: lane.id` on the state.
- `ExecutorLeased` case (442-447): pass `clone: event.clone` into `reduceLease`; in `reduceLease`'s `coder` branch set `clone: lease.clone` on the lane next to `executor`; in the `reviewer` and `judge` branches add `borrowed: held.judge.borrowed + (borrowed ? 1 : 0)` where `borrowed` is a new boolean argument taken from `event.borrowed === true`. Log `${cloneName(lease.executor, lease.clone)} → coder · S01` (import `cloneName` from `@llm4ts/flow/FlowEvents`), and for a borrowed judge log `judge borrowed from own executor · <label>`.
- New cases:

```ts
      case "TasksPlanned":
        return lane === undefined ? current : updateLane(current, lane.id, (open) => ({
          ...open,
          tasks: event.tasks.map((task, position) => ({
            index: position + 1, title: task.title, done: task.completed,
            ...(task.satisfies === undefined ? {} : { satisfies: task.satisfies })
          }))
        }))
      case "TaskStarted":
        return lane === undefined ? current : updateLane(current, lane.id, (open) => ({
          ...open,
          task: { index: event.index, count: event.count, title: event.title, ...(event.satisfies === undefined ? {} : { satisfies: event.satisfies }) },
          tasks: open.tasks.some((task) => task.index === event.index)
            ? open.tasks
            : [...open.tasks, { index: event.index, title: event.title, done: false, ...(event.satisfies === undefined ? {} : { satisfies: event.satisfies }) }].sort((a, b) => a.index - b.index)
        }))
      case "TaskCompleted":
        return lane === undefined ? current : updateLane(current, lane.id, (open) => ({
          ...open,
          task: undefined,
          tasks: open.tasks.map((task) => (task.index === event.index ? { ...task, done: true } : task))
        }))
      case "StoryStatusChanged": {
        const known = current.stories.some((story) => story.id === event.id)
        return {
          ...current,
          stories: known
            ? current.stories.map((story) => (story.id === event.id ? { ...story, status: event.status } : story))
            : [...current.stories, { id: event.id, status: event.status }]
        }
      }
```

- `ToolUse` case (489-497): when `event.parent` is set and the lane has an open child (`!ended`), update that child's `lastTool` and leave the lane's `lastTool` alone; when `toolCategory(event.tool, event.args) === "delegate"` (import from `@llm4ts/flow/Activity`), append a `TreeChild` and also set the lane activity as today; otherwise as today.
- `Timed` case (382-407): `kind: "tool"` with `category === "delegate"` marks the newest open child `ended: true`; `kind: "wait"` on a lane clears `pause` when its label matches.
- `Began` case (408): `kind: "wait"` on a lane with a label starting with `pi ` sets `pause: { label, since: at }` (keep the existing `running` push too).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/runner/test/AgentTree.test.ts && pnpm typecheck`
Expected: PASS, goldens still identical (the renderer has not changed yet).

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/AgentTree.ts packages/runner/test/AgentTree.test.ts
git commit -m "runner: the agent tree reduces clones, tasks, sub-agents, board moves and borrowed judges (ADR 0033)"
```

---

### Task 8: The list, the detail box, the boards mode and the keys

**Files:**

- Modify: `packages/runner/src/AgentTree.ts:701-726` (`TreeMode`, `TreeView`, `initialView`), `:744-801` (`onTreeKey`), `:813-814` (constants), `:820-837` (`railOf`), `:1111-1172` (`mainOf`), `:1198-1261` (`frameOf`, `renderTree`)
- Modify: `packages/runner/test/AgentTree.test.ts` (goldens helper, the lane-box test, new tests)
- Create: `packages/runner/test/fixtures/agent-tree.boards-90.txt`, `packages/runner/test/fixtures/agent-tree.clones.trace.jsonl`, `packages/runner/test/fixtures/agent-tree.clones-120.txt`
- Modify: `packages/runner/test/fixtures/agent-tree.lanes-90.txt`, `agent-tree.lanes-120.txt`, `agent-tree.executors-90.txt`

**Interfaces:**

- `TreeMode = "lanes" | "executors" | "boards"`; `TreeView.scroll: number` (first list row shown); `selectedLane(state, view): TreeLane | undefined` exported (the view's selection, else the lane in `state.lastChanged`, else the first running lane); keys: `b` toggles `boards`, `e` toggles `executors` as today, `enter` toggles `expanded` which now means "detail box shows the full tool list and stage log" (the detail box is always there).
- `renderTree` passes `options.height` into `frameOf`, which gives `mainOf` a row budget so the list and detail box fit before the log shrinks.

- [ ] **Step 1: Make goldens regenerable**

In `AgentTree.test.ts`, replace the `golden` helper with:

```ts
const golden = (name: string, width: number, view: TreeView, state = fixtureRun()): void => {
  const rendered = `${renderTree(state, { width, colour: false, view }).join("\n")}\n`
  if (process.env.UPDATE_GOLDENS === "1") {
    writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), rendered)
  }
  assert.strictEqual(rendered, fixture(name))
}
```

(import `writeFileSync` from `node:fs`). Commit nothing yet.

- [ ] **Step 2: Write the failing tests**

Replace the test `"draws three lanes at most and shows every board story as a chip"` (line 213) with:

```ts
it("lists every running lane, its children indented, and shows every board story as a chip", () => {
  const lines = frame(fixtureRun(), 120)
  const running = fixtureRun().lanes.filter((lane) => lane.status === "running")
  for (const lane of running) {
    assert.isTrue(
      lines.some((line) => line.includes(` ${lane.id} `)),
      `${lane.id} is listed`
    )
  }
  assert.isTrue(lines.some((line) => line.includes(`${running.length} running`)))
  for (const story of ["accounts", "payments", "iban", "overview", "movimenti", "bonifico"]) {
    assert.isTrue(lines.some((line) => line.includes(story)))
  }
})

it("draws the clones fixture as its golden frame, with a detail box for the latest lane", () => {
  golden("agent-tree.clones-120.txt", 120, initialView, clonesRun())
})

it("draws the boards mode as its golden frame", () => {
  golden("agent-tree.boards-90.txt", 90, { ...initialView, mode: "boards" }, clonesRun())
})

it("selects the most recently changed lane by default and scrolls the list by key", () => {
  const state = clonesRun()
  assert.strictEqual(selectedLane(state, initialView)?.id, state.lastChanged)
  const down = onTreeKey(initialView, "down", state)
  assert.notStrictEqual(down, "quit")
  const boards = onTreeKey(initialView, "b", state)
  assert.strictEqual(boards !== "quit" && boards.mode, "boards")
  const back = boards === "quit" ? initialView : onTreeKey(boards, "b", state)
  assert.strictEqual(back !== "quit" && back.mode, "lanes")
})

it("fits a short terminal by shortening the list before the log", () => {
  const state = clonesRun()
  const lines = renderTree(state, { width: 120, colour: false, view: initialView, height: 30 })
  assert.isAtMost(lines.length, 30)
  assert.isTrue(lines.some((line) => line.includes("running")))
  assert.isTrue(lines.at(-1)?.includes("run [") ?? false)
})
```

Add `clonesRun()` next to `fixtureRun()`: it folds `agent-tree.clones.trace.jsonl` from `emptyTree({ title: "epic bank-login", stories: [...] })`. Write that trace by hand (one JSON line per event, same envelope as `agent-tree.trace.jsonl`): five stories S01–S05 as in the prototype in `tools/prototype/watch-tui.ts`; S01 leased `codex` clone 1 with `TasksPlanned` (5 tasks, satisfies 1,1,2,3,3), `TaskStarted 3/5`, a `ToolUse Agent` then a `ToolUse Read` with `parent`, a `TokensUsed`; S02 `codex` clone 2; S03 `claude` clone 1 with a `Began wait "pi compaction"`; S04 `codex` clone 3 with a borrowed `judge` lease and a `StoryJudged`; S05 waiting (`Began wait "roster coder"`); `StoryStatusChanged` lines for S00 done and S06, S07 planned. Keep timestamps increasing by 1000 ms; the last event on S01 so it is `lastChanged`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/runner/test/AgentTree.test.ts`
Expected: FAIL: `selectedLane` not exported, `mode: "boards"` a type error, goldens missing, the clones frame shows three boxes.

- [ ] **Step 4: Implement the view**

In `AgentTree.ts`:

- `TreeMode` and `TreeView`: add `"boards"` and `readonly scroll: number` (`initialView.scroll = 0`).
- Export:

```ts
/** The lane the detail box is about: the selection, else the lane that moved last, else the first running one. */
export const selectedLane = (state: TreeState, view: TreeView): TreeLane | undefined => {
  const running = runningLanes(state)
  return (
    running.find((lane) => lane.id === view.selected) ??
    running.find((lane) => lane.id === state.lastChanged) ??
    running[0]
  )
}
```

- `onTreeKey`: `choices` in `lanes` mode stays the running lane ids; `index` uses `selectedLane(state, view)?.id` when `view.selected` is undefined; add `case "b": return { ...view, mode: view.mode === "boards" ? "lanes" : "boards", expanded: false, tail: false }`; `"e"` keeps toggling `executors`/`lanes`; `select` also adjusts `scroll` so the selected row is visible given `listRows` (pass the visible row count through the view as `view.rows`? No: keep `scroll` as the first visible row and clamp it in the renderer; `select` sets `scroll` to `Math.max(0, next - 5)` when `next < scroll` or `next > scroll + 10`).
- Delete `maxLaneBoxes`. In `mainOf`, replace the lane-box branch with:

```ts
const agentRows = (state: TreeState, width: number, view: TreeView, rows: number): Array<Line>
```

which draws one `Line` per running lane: `▸ ` or two spaces, `lane.id` padded to 10, `cloneName(lane.executor ?? "(leasing)", lane.clone)` padded to 12, `task n/m title` padded to a third of the width, the open stage, `elapsed(lane.startedAt, now)`, `formatCount(lane.tokens) tok`, then the `statusLine` mark and `lane.pause?.label`; then one indented child line per `lane.children` not ended (`    └ sub-agent <tool> <args> · <lastTool> · <elapsed since>`); then slices `[view.scroll, view.scroll + rows)` and, when cut, ends with a dim `… N more` row.

```ts
const detailBox = (lane: TreeLane, width: number, now: number | undefined, expanded: boolean): Array<Line>
```

which is `box(width, "running", body, `${lane.id} · ${cloneName(lane.executor ?? "(leasing)", lane.clone)}${lane.task ? ` · task ${lane.task.index}/${lane.task.count}` : ""}`)` with body: one line per `lane.tasks` (`[x]`/`[▶]`/`[ ]`, index, title, right-aligned `satisfies n`), `lane.task?.satisfies` as `satisfies <n>` on its own line when set, `stage  <stages.at(-1)>`, `doingLine`, `tools  <last 3, or last 20 when expanded>`, the elapsed/tokens/cost/turns line as `laneBox` prints it, and `pause` as `⏸ <label> <elapsed>` when set. A lane with no tasks and no task shows `no task plan yet` instead of the checklist.

`mainOf` composes: header boxes as today, `centre("agents · N running · <busy/slots per executor>")` built from `state.leases` grouped by executor (`codex 2/3` needs the slot count, which the tree does not know: print `codex ×2` for the number of leases held instead), then `agentRows`, then `detailBox(selected, ...)`, then `[]` and the chips. `expandedLane` is removed (its content lives in the detail box with `expanded`). The `executors` mode keeps `columnsOf(executors, ...)` but with every executor, wrapped by `columnsOf` into as many rows of up to four as needed.

- `boards` mode: `boardsOf(state, width, view)` draws `epic board` as five `box`es side by side (`planned`, `active`, `waiting`, `done`, `failed`; `skipped` counts under `done` with a `~` mark), each listing its stories with, for a running lane, a second line `<clone> <done>/<count> <bar>`; then `story board · <selected lane>` as four boxes (`todo`, `doing`, `review`, `done`) from `lane.tasks` and `lane.task` (`doing` is the running task; `review` is empty in this release; `done` is `done: true`). Widths: `Math.floor((width - 4) / 5)` and `Math.floor((width - 3) / 4)`.
- `railOf`: add a line `borrowed  <n>` after `verdicts` when `state.judge.borrowed > 0`.
- `frameOf(state, options, logCount)`: compute `mainRows = height - fixedRows` where `fixedRows` is the header (3) + log box (`logCount + 2`, or 0 for `"none"`) + status lines (2 or 3) + the chips rows + the orchestrator and judgment boxes' heights + the detail box height; pass `Math.max(3, mainRows)` into `mainOf` as the list budget. When `height` is undefined, the budget is unbounded. `renderTree` keeps its loop: it tries the full log first, shrinks it, and only then `fitToRows`.

- [ ] **Step 5: Regenerate the goldens and review them**

Run: `UPDATE_GOLDENS=1 pnpm vitest run packages/runner/test/AgentTree.test.ts`, then open the five `.txt` fixtures and check by eye: every line is exactly `width` wide, every running lane of the fixture trace is listed, the detail box is about the last-changed lane, the boards frame has five then four boxes, and nothing from the old three-box layout remains. Then `pnpm vitest run packages/runner/test/AgentTree.test.ts packages/runner/test/Watch.test.ts packages/runner/test/AgentTreeSurface.test.ts`.
Expected: PASS. A Watch or Surface test that asserts the old `delegate to roster` line or a box title changes to the new text.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/AgentTree.ts packages/runner/test
git commit -m "runner: list-first agent tree with one detail box, boards mode and a row budget (ADR 0033)"
```

---

### Task 9: Docs, changelog, ADR status, version

**Files:**

- Modify: `docs/observability.md` (the agent tree section: keys, list, detail box, boards, clones)
- Modify: `docs/adr/0033-executor-clones-and-list-first-dashboard.md` (Status: Accepted)
- Modify: `docs/adr/0019-executor-roster.md` (an amendment paragraph: `coderSlots` default, clones)
- Modify: `docs/adr/0022-agent-tree-dashboard.md` (an amendment paragraph: layout superseded by 0033)
- Modify: `CHANGELOG.md`, every `packages/*/package.json` via `pnpm version:set 2.41.0`

- [ ] **Step 1: Write the docs**

In `docs/observability.md`, find the section that describes `llm4ts watch` and `--ui tree` (search `agent tree`) and rewrite its layout paragraph: header boxes, `agents · N running` line, one line per running lane with children indented, the detail box (checklist with `[x]`/`[▶]`/`[ ]`, `satisfies n`, stage, tools, pause), the keys (`↑↓` or `1-9` select, `enter` expand, `e` executors, `b` boards, `t` tail, `l` log, `q` quit), the `boards` mode, and that clones appear as `codex#2`. Add a `## Amendment (2026-10-10)` to ADR 0019 and ADR 0022 of three sentences each pointing at ADR 0033, and set ADR 0033's status line to `Status: Accepted`.

In `CHANGELOG.md` add at the top:

```markdown
## 2.41.0

A roster slot is a clone, every running agent is a line in the watch
dashboard, and tasks, board moves and harness sub-agents are in the trace.

- **A slot is a clone** (ADR 0033). `coderSlots` now defaults to `slots`;
  a roster that kept a slot for reasoning sets it explicitly. Leases carry a
  clone number: the roster log says `codex#2 takes coder · S01`, the
  dashboard, the cost ledger (`byExecutor`, schema 3) and transcripts show it.
- **List-first dashboard.** `llm4ts watch` and `--ui tree` list every running
  story on one line each, with task coders and sub-agents indented, and one
  detail box for the selected story: the task checklist, the acceptance
  criterion the running task satisfies, the stage, the tools, and a harness
  pause (retrying, compacting). The three-box cap is gone; the list fits the
  terminal and scrolls. `b` opens the boards mode: the epic board and the
  selected story's task board.
- **Tasks and board moves are events.** `TasksPlanned`, `TaskStarted`,
  `TaskCompleted` and `StoryStatusChanged` are in the trace; the classic
  surface prints nothing new.
- **Sub-agents are observed.** Tool calls a harness delegated carry a
  `parent`; Claude's `Agent`, Codex's `spawn_agent` and Gemini's agents are
  the `delegate` category; Claude usage is summed over `modelUsage`, which
  includes sub-agents.
- **pi's richer events.** Retries and compaction show as a pause on the lane,
  tool durations come from pi, nested calls carry their parent, and an
  aborted turn is a typed failure.
```

- [ ] **Step 2: Bump and verify**

Run:

```bash
pnpm version:set 2.41.0
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm build && node scripts/pack-smoke.mjs
```

Expected: every command green; the pack smoke resolves every subpath.

- [ ] **Step 3: Commit**

```bash
git add -A docs CHANGELOG.md packages/*/package.json
git commit -m "Release 2.41.0: executor clones and the list-first dashboard (ADR 0033)"
```

The tag and push happen after the branch is merged, per the repo's release flow in `CLAUDE.md`.
