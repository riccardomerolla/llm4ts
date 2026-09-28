# Story Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The per-story "mergeable" decision of `epic-stories` expressed as a blackboard ruleset, shipped as a fork flow `epic-stories-board` beside the unchanged `epic-stories`.

**Architecture:** Flow gains a small `Blackboard.ts` (`decideRule`, event and error helpers) and a `BlackboardRun` event. The ruleset and its adapter live in `flows/lib/story-board.ts` and plug into `implementStoriesFlow`'s existing `judge` seam. The program body of `flows/epic-stories.ts` moves verbatim into `runEpicStories({ storyJudge })` in `flows/lib/epic-stories.ts`; the two flow entries differ only in the judge they pass.

**Tech Stack:** TypeScript, Effect 4 rc.115, `@llm4ts/core/blackboard/*` (2.14.0), `@effect/vitest`.

**Spec:** `docs/superpowers/specs/2026-09-28-story-board-design.md`

## Global Constraints

- Effect 4 pinned at `4.0.0-rc.115`; check `.repos/effect/packages/effect/src/*.ts` for any API you are unsure of.
- No `any`, no type assertions of any kind (eslint `consistent-type-assertions`), no namespaces, no unmanaged promises, no global `Error` as a domain error; expected failures are `Schema.TaggedError`s.
- `.ts` relative imports; package imports use explicit subpaths listed in the package's `exports`.
- Core is not touched. Policy (`decide`, `JudgmentPolicy`) stays in flow.
- The bar: mergeable iff every dimension's expected score ≥ 1.5 and its decision is `act`.
- `flows/epic-stories.ts` keeps its behaviour; `flows/test/epic-stories.test.ts` must stay green **unchanged**.
- Fact values (the diff, the brief) never appear in error messages; only rule names, key names and dimension names.
- Tests are deterministic and offline (`FakeJudgment`, memory stores). Verification before each commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (`pnpm format` fixes formatting).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A backend that answers three of the four dimensions → the round fails with a `FlowError` naming the missing dimension, never a merge on a partial verdict (Task 3).
2. A `caution` decision on a passing score → not mergeable, one "unsure" issue naming the dimension (Task 3).
3. An expected score of exactly 1.5 → passes the bar (Task 3).
4. `epic-stories-board` receives the same flags and environment as `epic-stories` (`--plan-only`, `--land`, `--list`, `--epic`, `LLM4TS_*`) because it runs the same program (Task 4: the header comment says so and the test pins that both entries use `runEpicStories`).
5. The `BlackboardRun` event survives the trace round trip (`TraceLine.fields` is `Record<string, Json>`), so a reader can decode the `RunResult` back (Task 1).

---

### Task 1: Flow-level blackboard helpers and the `BlackboardRun` event

**Files:**

- Create: `packages/flow/src/Blackboard.ts`
- Modify: `packages/flow/src/FlowEvents.ts` (the `JudgmentOutcome` union near line 15, the `JudgmentObserved.consumer` literals near line 26, the `FlowEvent` union at line 167)
- Modify: `packages/flow/package.json` (`exports`: add `"./Blackboard": "./dist/Blackboard.js"` in alphabetical position, before `"./BoardSync"`)
- Test: `packages/flow/test/Blackboard.test.ts`

**Interfaces:**

- Consumes: `makeKey`, `FactKey` (`@llm4ts/core/blackboard/Fact`); `derive`, `on`, `Rule` (`@llm4ts/core/blackboard/Rule`); `RunResult`, `RunError` (`@llm4ts/core/blackboard/Run`); `RulesetInvalid` (`@llm4ts/core/blackboard/Ruleset`); `Answer` (`@llm4ts/core/judgment/Schemas`); `decide`, `JudgmentPolicy`, `defaultJudgmentPolicy` (`./Judgment.ts`); `Decision` (`./JudgmentTypes.ts`); `FlowLlmError` (`./FlowError.ts`); `ProviderError` (`@llm4ts/core/Errors`).
- Produces:
  - `answerKey(name: string): FactKey<Answer>`; `decisionKey(name: string): FactKey<Decision>`
  - `decideRule(options: { name: string; answer: FactKey<Answer>; decision: FactKey<Decision>; policy?: JudgmentPolicy }): Rule`
  - `runErrorToFlowError(error: RunError | RulesetInvalid): FlowError`
  - `publishBlackboardRun(events: FlowEventsShape, ruleset: string, result: RunResult): Effect.Effect<void>`
  - In `FlowEvents.ts`: `class BlackboardRun` TaggedClass `{ ruleset: String, result: RunResult }`, member of `FlowEvent`; `JudgmentObserved.consumer` gains `"story-board"`; `JudgmentOutcome` gains `Schema.TaggedStruct("StoryBoard", { dimension: Schema.String, score: Schema.Number, mergeable: Schema.Boolean })`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/Blackboard.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { DuplicateFact, makeKey } from "@llm4ts/core/blackboard/Fact"
import { ExportsMissing, RunResult } from "@llm4ts/core/blackboard/Run"
import { RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { origins, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  answerKey,
  decideRule,
  decisionKey,
  publishBlackboardRun,
  runErrorToFlowError
} from "@llm4ts/flow/Blackboard"
import { BlackboardRun, FlowEvent, makeFlowEventHub, TraceLine } from "@llm4ts/flow/FlowEvents"
import { JudgmentPolicy } from "@llm4ts/flow/Judgment"

const blocking = answerKey("review.blocking")
const verdict = decisionKey("decision.blocking")

describe("decideRule", () => {
  it.effect("posts act, caution or hold from the answer and the policy", () =>
    Effect.gen(function* () {
      const rule = decideRule({ name: "decide", answer: blocking, decision: verdict })
      assert.deepStrictEqual(rule.reads, ["review.blocking"])
      assert.deepStrictEqual(rule.produces, ["decision.blocking"])
      const fire = (truth: number, support = 1) =>
        Effect.gen(function* () {
          const encoded = yield* blocking.of(truthAnswer(truth, origins.fake(), support)).encoded
          const prepared = yield* rule.prepare(new Map([["review.blocking", encoded]]))
          assert.isTrue(Option.isSome(prepared))
          if (!Option.isSome(prepared)) return "hold"
          const posted = yield* prepared.value
          return yield* verdict.read(yield* posted.facts[0]!.encoded)
        })
      assert.strictEqual(yield* fire(0.99), "act")
      assert.strictEqual(yield* fire(0.6), "hold")
      // Support below the policy's floor is always held, however certain.
      assert.strictEqual(yield* fire(0.99, 0.1), "hold")
      const lenient = decideRule({
        name: "decide",
        answer: blocking,
        decision: verdict,
        policy: JudgmentPolicy.make({ minSupport: 0 })
      })
      const encoded = yield* blocking.of(truthAnswer(0.99, origins.fake(), 0.1)).encoded
      const prepared = yield* lenient.prepare(new Map([["review.blocking", encoded]]))
      if (Option.isSome(prepared)) {
        const posted = yield* prepared.value
        assert.strictEqual(yield* verdict.read(yield* posted.facts[0]!.encoded), "act")
      }
    })
  )
})

describe("run errors as flow errors", () => {
  it("names rules and keys, never values", () => {
    const missing = ExportsMissing.make({
      missing: [
        {
          key: "story.mergeable",
          waitingRules: [{ rule: "bar", missingKeys: ["judge.tests"] }],
          silentRules: []
        }
      ],
      trace: [],
      failures: []
    })
    const error = runErrorToFlowError(missing)
    assert.strictEqual(error._tag, "Llm")
    assert.include(error.message, "story.mergeable")
    assert.include(error.message, "judge.tests")
    const invalid = runErrorToFlowError(
      RulesetInvalid.make({ name: "board", problems: [{ kind: "UnproducedExport", key: "x" }] })
    )
    assert.include(invalid.message, "board")
    assert.include(runErrorToFlowError(DuplicateFact.make({ key: "k" })).message, "k")
  })
})

describe("BlackboardRun event", () => {
  it.effect("is published to the hub and round-trips through the event and trace schemas", () =>
    Effect.gen(function* () {
      const hub = yield* makeFlowEventHub()
      const result = RunResult.make({
        board: { facts: { "story.mergeable": true } },
        trace: [],
        failures: []
      })
      const seen = yield* hub.collect(publishBlackboardRun(hub, "story-board", result))
      const event = seen.find((e): e is BlackboardRun => e._tag === "BlackboardRun")
      assert.isDefined(event)
      assert.strictEqual(event?.ruleset, "story-board")
      const json = yield* Schema.encodeEffect(FlowEvent)(event!)
      const back = yield* Schema.decodeUnknownEffect(FlowEvent)(json)
      assert.strictEqual(back._tag, "BlackboardRun")
      if (back._tag === "BlackboardRun") {
        assert.deepStrictEqual(back.result.board.facts, { "story.mergeable": true })
      }
      // As the recorder stores it: the encoded event's fields are JSON.
      const fields = yield* Schema.decodeUnknownEffect(TraceLine.fields.schema)(json)
      assert.isDefined(fields)
    })
  )
})
```

`hub.collect` is a name used here for "run this effect and return the events it published"; look in `packages/flow/test/FlowEvents.test.ts` or `packages/flow/src/FlowEvents.ts` for the hub's actual helper (a `Ref`-backed subscriber, or `makeFlowEventHub` plus `hub.stream` drained with `Stream.runCollect`) and use that instead. `TraceLine.fields.schema` likewise: if `Schema.Class` does not expose field schemas that way, decode with `Schema.Record(Schema.String, Schema.Json)` directly, which is the trace's field type.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/Blackboard.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/flow/Blackboard`.

- [ ] **Step 3: Extend `FlowEvents.ts`**

In `JudgmentOutcome` (line 15), add a member:

```ts
Schema.TaggedStruct("StoryBoard", {
  dimension: Schema.String,
  score: Schema.Number,
  mergeable: Schema.Boolean
})
```

In `JudgmentObserved` (line 26), extend the consumer literals:

```ts
  consumer: Schema.Literals(["review-prescreen", "satisfied-probe", "program-judge", "story-board"]),
```

Add the event class (after `Declassified`), importing `RunResult`:

```ts
import { RunResult } from "@llm4ts/core/blackboard/Run"

/** A blackboard ruleset ran (ADR 0020): its board, trace and failures, for the trace file. */
export class BlackboardRun extends Schema.TaggedClass<BlackboardRun>()("BlackboardRun", {
  ruleset: Schema.String,
  result: RunResult
}) {}
```

Add `BlackboardRun` to the `FlowEvent` union (line 167). Then run `pnpm typecheck`: any exhaustive `switch` over `FlowEvent["_tag"]` in `packages/flow`, `packages/runner` or `packages/shell` now fails to compile; add a `case "BlackboardRun"` to each that does, treating it like `Declassified` (rendered as nothing, or as an `Info`-style line `blackboard <ruleset>: <n> firings, <m> failures` where a renderer prints every event). Find them with `grep -rn '"Declassified"' packages/*/src`.

- [ ] **Step 4: Implement `Blackboard.ts`**

```ts
// packages/flow/src/Blackboard.ts
import * as Effect from "effect/Effect"
import { makeKey, type FactKey } from "@llm4ts/core/blackboard/Fact"
import { derive, on, type Rule } from "@llm4ts/core/blackboard/Rule"
import type { RunError, RunResult } from "@llm4ts/core/blackboard/Run"
import { renderProblem, type RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { ProviderError } from "@llm4ts/core/Errors"
import { Answer } from "@llm4ts/core/judgment/Schemas"
import { FlowLlmError, type FlowError } from "./FlowError.ts"
import { BlackboardRun, type FlowEventsShape } from "./FlowEvents.ts"
import { decide, defaultJudgmentPolicy, type JudgmentPolicy } from "./Judgment.ts"
import { Decision } from "./JudgmentTypes.ts"

/**
 * What flow adds to the core blackboard (ADR 0020): the policy step core
 * refuses to take. A `judge` rule posts an `Answer`; `decideRule` turns it
 * into `act | caution | hold` with the run's `JudgmentPolicy`, so a company
 * ruleset reads decisions, not probabilities.
 */

export const answerKey = (name: string): FactKey<Answer> => makeKey(name, Answer)
export const decisionKey = (name: string): FactKey<Decision> => makeKey(name, Decision)

export interface DecideRuleOptions {
  readonly name: string
  readonly answer: FactKey<Answer>
  readonly decision: FactKey<Decision>
  readonly policy?: JudgmentPolicy
}

export const decideRule = (options: DecideRuleOptions): Rule =>
  derive({
    name: options.name,
    condition: on(options.answer),
    produces: [options.decision],
    derive: (answer) => [
      options.decision.of(decide(answer, options.policy ?? defaultJudgmentPolicy))
    ]
  })

/** A run or ruleset failure as the flow's LLM error; messages name rules and keys only. */
export const runErrorToFlowError = (error: RunError | RulesetInvalid): FlowError => {
  const message =
    error._tag === "RulesetInvalid"
      ? `ruleset "${error.name}" is invalid: ${error.problems.map(renderProblem).join("; ")}`
      : error.message
  return FlowLlmError.from(ProviderError.make({ message: `blackboard: ${message}` }))
}

export const publishBlackboardRun = (
  events: FlowEventsShape,
  ruleset: string,
  result: RunResult
): Effect.Effect<void> => events.publish(BlackboardRun.make({ ruleset, result }))
```

If `ProviderError.make` requires a `cause`, pass `{ message, cause: error }` only when `Schema.Defect()` accepts it; otherwise leave it out — the message carries what a reader needs.

- [ ] **Step 5: Run the tests, verify, commit**

Run: `pnpm vitest run packages/flow/test/Blackboard.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 3 tests PASS; clean.

```bash
git add packages/flow/src/Blackboard.ts packages/flow/src/FlowEvents.ts packages/flow/package.json packages/flow/test/Blackboard.test.ts
git commit -m "flow: decideRule, BlackboardRun event and run-error mapping for blackboard consumers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `runEpicStories` — the shared program with the judge as an option

**Files:**

- Modify: `flows/lib/epic-stories.ts` (append `StoryJudgeContext`, `StoryJudge`, `rubricStoryJudge`, `runEpicStories`)
- Modify: `flows/epic-stories.ts` (the program body, lines 86–321, moves out)
- Test: `flows/test/epic-stories.test.ts` (one new test; nothing existing changes)

**Interfaces:**

- Consumes: `implementStoriesFlow`, `StorySeats`, `StoriesOptions` (`@llm4ts/flow/Stories`); `judgeStory`, `storyJudgeQuery` (already in `flows/lib/epic-stories.ts`).
- Produces:
  - `type StoryJudge = NonNullable<StoriesOptions["judge"]>`
  - `interface StoryJudgeContext { readonly plan: StoryPlan; readonly budget: number; readonly reasoning: LlmServiceShape; readonly events: FlowEventsShape; readonly files: PlainFileStoreShape; readonly houseRules: string }`
  - `rubricStoryJudge(context: StoryJudgeContext): StoryJudge` — today's behaviour
  - `runEpicStories(options: { readonly storyJudge: (context: StoryJudgeContext) => StoryJudge }): Effect.Effect<void, FlowError | …>` — the moved program

- [ ] **Step 1: Write the failing test**

Append to `flows/test/epic-stories.test.ts`, inside a new `describe` at the end of the file (the file already imports `Effect`, `assert`, `describe`, `it`, `ReviewResult`, `makeFlowEventHub`, `makeMemoryPlainFileStore` and a fake `LlmServiceShape` helper — reuse the file's existing `structured(...)`/`cleanReview` helper for the reasoning fake and the existing `story`/`plan` fixtures near line 440):

```ts
describe("story judge factories", () => {
  it.effect("rubricStoryJudge judges with today's rubric judge and clears a clean review", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const memory = yield* makeMemoryPlainFileStore()
      const judge = rubricStoryJudge({
        plan,
        budget: 1000,
        reasoning: cleanReview,
        events,
        files: memory.store,
        houseRules: "rules"
      })
      const verdict = yield* judge(story, "diff", {
        context: fakeContext(cleanReview),
        totals: undefined
      })
      assert.isTrue(verdict.isClean)
    })
  )
})
```

Use the test file's existing names for the plan/story fixtures and its context builder (search the file for how the existing `judgeStory` test at line ~457 builds `strict`, `story`, and how `implementStoriesFlow` tests build a `StorySeats`); the shape above is `StorySeats = { context: FlowContextShape; totals?: … }` from `packages/flow/src/Stories.ts:73`. Add `rubricStoryJudge` to the `../lib/epic-stories.ts` import list.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run flows/test/epic-stories.test.ts -t "story judge factories"`
Expected: FAIL — `rubricStoryJudge` is not exported.

- [ ] **Step 3: Move the program**

In `flows/lib/epic-stories.ts`, append:

```ts
// ---- The flow program, shared by epic-stories and its forks -------------------

export type StoryJudge = NonNullable<StoriesOptions["judge"]>

/** What a story judge is built from, once per run. */
export interface StoryJudgeContext {
  readonly plan: StoryPlan
  readonly budget: number
  /** The metered reasoning seat; a roster's judge seat wins per story when present. */
  readonly reasoning: LlmServiceShape
  readonly events: FlowEventsShape
  readonly files: PlainFileStoreShape
  readonly houseRules: string
}

/** Today's story judge: the rubric judge over the four dimensions. */
export const rubricStoryJudge =
  (context: StoryJudgeContext): StoryJudge =>
  (story, diff, seats) =>
    judgeStory(
      seats.context.roster?.forRole("judge") ?? context.reasoning,
      story,
      diff,
      context.budget,
      context.plan
    )

export interface EpicStoriesOptions {
  readonly storyJudge: (context: StoryJudgeContext) => StoryJudge
}
```

Then move the body of `const program = Effect.gen(function* () { … })` from `flows/epic-stories.ts` (lines 94–319) into:

```ts
export const runEpicStories = (options: EpicStoriesOptions) =>
  Effect.gen(function* () {
    // … the body, verbatim …
  })
```

with exactly one change inside: the `judge:` option passed to `implementStoriesFlow` (lines 277–283 today) becomes

```ts
            judge: options.storyJudge({
              plan,
              budget: contextBudget,
              reasoning: reasoningMeter.service,
              events,
              files,
              houseRules: guidance
            }),
```

Move the helpers the body uses and that live only in `flows/epic-stories.ts` (`defaultEpic`, the `withFlags`/`CliConnectorConfig` helper at lines 86–89, and any import the body needs) into `flows/lib/epic-stories.ts` too, keeping their names. `guidance`, `plan`, `contextBudget`, `reasoningMeter`, `events`, `files` are all in scope at that point of the body today; keep their definitions where they are.

`flows/epic-stories.ts` becomes its header comment (unchanged: the shell's catalog reads the first line) plus:

```ts
import { runFlowMain } from "@llm4ts/runner"
import { rubricStoryJudge, runEpicStories } from "./lib/epic-stories.ts"

runFlowMain(runEpicStories({ storyJudge: rubricStoryJudge }))
```

- [ ] **Step 4: Run the whole epic-stories suite, verify, commit**

Run: `pnpm vitest run flows/test/epic-stories.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: every existing test PASS plus the new one; clean. `git diff --stat flows/test/epic-stories.test.ts` shows only the appended test.

```bash
git add flows/lib/epic-stories.ts flows/epic-stories.ts flows/test/epic-stories.test.ts
git commit -m "epic-stories: the program is runEpicStories with the story judge as an option

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The story board ruleset and its adapter

**Files:**

- Create: `flows/lib/story-board.ts`
- Test: `flows/test/story-board.test.ts`

**Interfaces:**

- Consumes: `makeKey` (`@llm4ts/core/blackboard/Fact`); `all`, `derive`, `judge`, `on` (`@llm4ts/core/blackboard/Rule`); `makeRuleset`, `Ruleset` (`@llm4ts/core/blackboard/Ruleset`); `runRuleset` (`@llm4ts/core/blackboard/Run`); `dimensionQuestion` (`@llm4ts/core/eval/Judge`); `Judgment`, `JudgmentShape` (`@llm4ts/core/judgment/Judgment`); `ScoreAnswer`, `Answer` (`@llm4ts/core/judgment/Schemas`); `answerKey`, `decisionKey`, `decideRule`, `publishBlackboardRun`, `runErrorToFlowError` (Task 1); `JudgmentObserved`, `publishJudgmentObserved` (`@llm4ts/flow/FlowEvents`); `certaintyOf`, `decide`, `JudgmentPolicy` (`@llm4ts/flow/Judgment`); `Decision` (`@llm4ts/flow/JudgmentTypes` — check it is exported from `@llm4ts/flow/Judgment` too, and import from there if so); `ReviewIssue`, `ReviewResult` (`@llm4ts/flow/Review`); `dependenciesOf`, `Story`, `StoryPlan` (`@llm4ts/flow/StoryPlan`); `cap` (`@llm4ts/flow/Context`); `storyDimensions`, `storyJudgeQuery`, `StoryJudge`, `StoryJudgeContext` (`./epic-stories.ts`).
- Produces:
  - `class StoryBrief` (Schema.Class) `{ id, title, description, provides: Array<String>, owned: Array<String>, sharedReadOnly: Array<String>, dependencies: Array<Struct{ id, provides: Array<String> }> }`
  - `storyBriefOf(story: Story, plan?: StoryPlan): StoryBrief`
  - Keys: `storyBrief: FactKey<StoryBrief>`, `storyDiff: FactKey<string>`, `houseRules: FactKey<string>`, `judgeKeys: Record<dim, FactKey<Answer>>`, `decisionKeys: Record<dim, FactKey<Decision>>`, `mergeable: FactKey<boolean>`, `issues: FactKey<ReadonlyArray<ReviewIssue>>`
  - `dimensionNames = ["provides", "scope", "house-style", "tests"] as const` (a `const` tuple literal is a type annotation, not an assertion; if lint objects, declare it `: ReadonlyArray<DimensionName>` with the union type written out)
  - `makeStoryBoard(policy?: JudgmentPolicy): Effect<Ruleset<JudgmentBackendError, Judgment>, RulesetInvalid>`
  - `boardStoryJudge(context: StoryJudgeContext & { readonly judgment: JudgmentShape; readonly policy?: JudgmentPolicy }): Effect<StoryJudge, FlowError>` — builds the ruleset once, returns the seam closure
  - `passingScore = 1.5`

- [ ] **Step 1: Write the failing tests**

```ts
// flows/test/story-board.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Judgment } from "@llm4ts/core/judgment/Judgment"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { dimensionQuestion } from "@llm4ts/core/eval/Judge"
import { origins, scoreAnswer, type Answer } from "@llm4ts/core/judgment/Schemas"
import {
  makeFlowEventHub,
  type BlackboardRun,
  type JudgmentObserved
} from "@llm4ts/flow/FlowEvents"
import { JudgmentPolicy } from "@llm4ts/flow/Judgment"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import { storyDimensions } from "../lib/epic-stories.ts"
import { boardStoryJudge, makeStoryBoard, storyBriefOf } from "../lib/story-board.ts"

const story = Story.make({
  id: "conto",
  title: "Current account",
  description: "Balance and movements",
  owned: ["src/features/conto/"],
  provides: ["GET /api/conto"],
  dependsOn: ["kit"]
})
const kit = Story.make({
  id: "kit",
  title: "Kit",
  description: "shared",
  owned: ["src/kit/"],
  provides: ["Money type"]
})
const plan = StoryPlan.make({ epicId: "e1", title: "Epic", stories: [kit, story] })

const level = (name: string, index: 0 | 1 | 2, support = 1): Answer => {
  const dimension = storyDimensions.find((d) => d.name === name)!
  return scoreAnswer(dimensionQuestion(dimension), { [String(index)]: 1 }, origins.fake(), support)
}
const allTop = Object.fromEntries(storyDimensions.map((d) => [d.name, level(d.name, 2)]))

const judgeWith = (answers: Record<string, Answer>, failures: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeJudgment({ answers, failures })
    const events = yield* makeFlowEventHub()
    const memory = yield* makeMemoryPlainFileStore()
    const judge = yield* boardStoryJudge({
      plan,
      budget: 10_000,
      reasoning: fake.judgment as never, // not used: the board judges through `judgment`
      events,
      files: memory.store,
      houseRules: "kit components only",
      judgment: fake.judgment
    })
    return { fake, events, judge }
  })
```

Replace the `as never` above: `reasoning` needs an `LlmServiceShape`; reuse the fake `LlmServiceShape` builder `flows/test/epic-stories.test.ts` already has (export it from a shared `flows/test/support.ts` if it is not exported, or copy its 10 lines into this file). Then the tests:

```ts
describe("the story board ruleset", () => {
  it.effect("is valid, with three imports, two exports and six rules", () =>
    Effect.gen(function* () {
      const board = yield* makeStoryBoard()
      assert.deepStrictEqual(board.imports, ["story.brief", "story.diff", "story.houseRules"])
      assert.deepStrictEqual(board.exports, ["story.mergeable", "story.issues"])
      assert.strictEqual(board.rules.length, 6)
      assert.deepStrictEqual(board.warnings, [])
      assert.include(board.describe(), "bar:")
    })
  )

  it("the brief carries the dependencies' declared interface", () => {
    const brief = storyBriefOf(story, plan)
    assert.deepStrictEqual(brief.dependencies, [{ id: "kit", provides: ["Money type"] }])
  })

  it.effect("four top scores merge; the run and every answer are published", () =>
    Effect.gen(function* () {
      const { fake, events, judge } = yield* judgeWith(allTop)
      const seen = yield* collect(events, judge(story, "+ code", seats))
      const verdict = yield* judge(story, "+ code", seats)
      assert.isTrue(verdict.isClean)
      assert.strictEqual(verdict.summary, "story-board:conto")
      const run = seen.find((e): e is BlackboardRun => e._tag === "BlackboardRun")
      assert.strictEqual(run?.ruleset, "story-board")
      assert.strictEqual(
        run?.result.trace.find((f) => f.rule === "story-judge")?.judgment?.backend,
        "fake"
      )
      const observed = seen.filter((e): e is JudgmentObserved => e._tag === "JudgmentObserved")
      assert.strictEqual(observed.length, 4)
      assert.isTrue(
        observed.every((o) => o.consumer === "story-board" && o.outcome._tag === "StoryBoard")
      )
      const requests = yield* fake.recorded
      assert.isTrue(String(requests[0]?.state).includes("Money type"))
      assert.isTrue(String(requests[0]?.state).includes("+ code"))
    })
  )

  it.effect("one dimension at level 1 is not mergeable, with one issue naming it", () =>
    Effect.gen(function* () {
      const { judge } = yield* judgeWith({ ...allTop, scope: level("scope", 1) })
      const verdict = yield* judge(story, "+ code", seats)
      assert.isFalse(verdict.isClean)
      assert.deepStrictEqual(
        verdict.issues.map((i) => i.title),
        ["judge[conto]: scope scored 1.0"]
      )
      assert.strictEqual(verdict.issues[0]?.severity, "Critical")
    })
  )

  it.effect("an expected score of exactly 1.5 passes the bar", () =>
    Effect.gen(function* () {
      const half = scoreAnswer(
        dimensionQuestion(storyDimensions[3]!),
        { "1": 0.5, "2": 0.5 },
        origins.fake()
      )
      const { judge } = yield* judgeWith({ ...allTop, tests: half }, {})
      // 0.5 confidence is `caution` under the default policy; make the policy lenient to isolate the score rule.
      const lenient = yield* judgeWithPolicy({ ...allTop, tests: half }, JudgmentPolicy.make({}))
      void judge
      const verdict = yield* lenient.judge(story, "+ code", seats)
      assert.isTrue(verdict.issues.every((i) => !i.title.includes("scored")))
    })
  )

  it.effect("a passing score whose decision is not act is an 'unsure' issue", () =>
    Effect.gen(function* () {
      const { judge } = yield* judgeWith({ ...allTop, "house-style": level("house-style", 2, 0.1) })
      const verdict = yield* judge(story, "+ code", seats)
      assert.isFalse(verdict.isClean)
      assert.deepStrictEqual(
        verdict.issues.map((i) => i.title),
        ["judge[conto]: unsure about house-style"]
      )
    })
  )

  it.effect("a dimension the backend could not score fails the round, naming it", () =>
    Effect.gen(function* () {
      const { judge } = yield* judgeWith(allTop, { tests: "no logprobs" })
      const error = yield* Effect.flip(judge(story, "+ code", seats))
      assert.include(error.message, "tests")
      assert.include(error.message, "conto")
    })
  )
})
```

Helpers this file needs, defined near the top: `seats` (a `StorySeats` with a context whose `roster` is undefined — build it with the same context builder the epic-stories test uses), `collect(events, effect)` (run the effect while subscribed to the hub and return the events; use the hub's real subscription API as in Task 1), and `judgeWithPolicy(answers, policy)` (same as `judgeWith` plus `policy`). In the "exactly 1.5" test, simplify to one call with a lenient policy whose `thresholds` accept 0.5 confidence, or assert on the board directly: build the ruleset with `makeStoryBoard(policy)`, run it with `runRuleset` and the fake `Judgment` layer, and check `story.mergeable`. Choose the direct route if the policy shape makes the adapter route awkward; the requirement is only that 1.5 passes the score bar.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run flows/test/story-board.test.ts`
Expected: FAIL — cannot resolve `../lib/story-board.ts`.

- [ ] **Step 3: Implement `flows/lib/story-board.ts`**

```ts
// flows/lib/story-board.ts
// The per-story "mergeable" decision as a blackboard ruleset (ADR 0020):
// a judge rule scores the four story dimensions with the Judgment service,
// decideRule turns each answer into act|caution|hold, and `bar` — the rule a
// company edits — posts whether the story may merge and the issues the coder
// gets back. Plugged into implementStoriesFlow's judge seam by boardStoryJudge.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeKey, type FactKey } from "@llm4ts/core/blackboard/Fact"
import { all, derive, judge } from "@llm4ts/core/blackboard/Rule"
import { runRuleset } from "@llm4ts/core/blackboard/Run"
import { makeRuleset, type Ruleset, type RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { dimensionQuestion } from "@llm4ts/core/eval/Judge"
import {
  Judgment,
  type JudgmentBackendError,
  type JudgmentShape
} from "@llm4ts/core/judgment/Judgment"
import type { Answer, ScoreAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  answerKey,
  decideRule,
  decisionKey,
  publishBlackboardRun,
  runErrorToFlowError
} from "@llm4ts/flow/Blackboard"
import { cap } from "@llm4ts/flow/Context"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { JudgmentObserved, publishJudgmentObserved } from "@llm4ts/flow/FlowEvents"
import { certaintyOf, decide, type Decision, type JudgmentPolicy } from "@llm4ts/flow/Judgment"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { dependenciesOf, type Story, type StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  storyDimensions,
  storyJudgeQuery,
  type StoryJudge,
  type StoryJudgeContext
} from "./epic-stories.ts"

export class StoryBrief extends Schema.Class<StoryBrief>("StoryBrief")({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  provides: Schema.Array(Schema.String),
  owned: Schema.Array(Schema.String),
  sharedReadOnly: Schema.Array(Schema.String),
  dependencies: Schema.Array(
    Schema.Struct({ id: Schema.String, provides: Schema.Array(Schema.String) })
  )
}) {}

export const storyBriefOf = (story: Story, plan?: StoryPlan): StoryBrief =>
  StoryBrief.make({
    id: story.id,
    title: story.title,
    description: story.description,
    provides: story.provides,
    owned: story.owned,
    sharedReadOnly: story.sharedReadOnly,
    dependencies:
      plan === undefined
        ? []
        : dependenciesOf(plan, story.id).flatMap((id) => {
            const dependency = plan.story(id)
            return dependency === undefined ? [] : [{ id, provides: dependency.provides }]
          })
  })

export const dimensionNames = storyDimensions.map((dimension) => dimension.name)

export const storyBrief = makeKey("story.brief", StoryBrief)
export const storyDiff = makeKey("story.diff", Schema.String)
export const houseRules = makeKey("story.houseRules", Schema.String)
export const mergeable = makeKey("story.mergeable", Schema.Boolean)
export const issues = makeKey("story.issues", Schema.Array(ReviewIssue))
export const judgeKeys: Readonly<Record<string, FactKey<Answer>>> = Object.fromEntries(
  dimensionNames.map((name) => [name, answerKey(`judge.${name}`)])
)
export const decisionKeys: Readonly<Record<string, FactKey<Decision>>> = Object.fromEntries(
  dimensionNames.map((name) => [name, decisionKey(`decision.${name}`)])
)

/** Expected level (of 2) a dimension must reach; the company's bar. */
export const passingScore = 1.5

const keyOf = <A>(table: Readonly<Record<string, FactKey<A>>>, name: string): FactKey<A> => {
  const key = table[name]
  if (key === undefined) throw new Error(`no fact key for dimension ${name}`)
  return key
}
```

The `throw` above is a programming error at module load (a dimension name without a key), never a run-time path; if lint or the repo's rules object to a bare `Error`, replace `keyOf` by building the four keys as named constants (`judgeProvides`, `judgeScope`, …) and use them directly — the four dimension names are fixed by `storyDimensions`.

```ts
/** The State the judge reads: the same words as the rubric judge, brief then diff. */
const stateOf = (brief: StoryBrief, diff: string, rules: string): string =>
  [
    `Story: ${brief.title}`,
    brief.description,
    "",
    `Provides: ${brief.provides.join(", ") || "(none)"}`,
    `Owned paths: ${brief.owned.join(", ")}`,
    `Shared read-only: ${brief.sharedReadOnly.join(", ") || "(none)"}`,
    ...(brief.dependencies.length === 0
      ? []
      : [
          "",
          "Already merged, from the stories this one depends on (their declared interface):",
          ...brief.dependencies.map(
            (d) => `- ${d.id}: ${d.provides.join("; ") || "(nothing declared)"}`
          ),
          "Using these exactly as declared (the same module, the same export) is correct and is",
          "never a house-style or scope problem, even where the module is a fake transport."
        ]),
    "",
    "House rules:",
    rules,
    "",
    "Diff:",
    diff
  ].join("\n")

const [jProvides, jScope, jStyle, jTests] = dimensionNames.map((name) => keyOf(judgeKeys, name))
const [dProvides, dScope, dStyle, dTests] = dimensionNames.map((name) => keyOf(decisionKeys, name))

const levelDescription = (answer: ScoreAnswer): string => {
  const rounded = String(Math.max(0, Math.min(2, Math.round(answer.score))))
  const legend = answer.legend[rounded]
  return typeof legend === "string" ? legend : JSON.stringify(legend ?? "")
}

export const makeStoryBoard = (
  policy?: JudgmentPolicy
): Effect.Effect<Ruleset<JudgmentBackendError, Judgment>, RulesetInvalid> => {
  if (
    jProvides === undefined ||
    jScope === undefined ||
    jStyle === undefined ||
    jTests === undefined ||
    dProvides === undefined ||
    dScope === undefined ||
    dStyle === undefined ||
    dTests === undefined
  ) {
    throw new Error("story dimensions changed; the story board keys must follow")
  }
  const storyJudge = judge({
    name: "story-judge",
    condition: all(storyBrief, storyDiff, houseRules),
    produces: [jProvides, jScope, jStyle, jTests],
    ask: ([brief, diff, rules]) => ({
      state: stateOf(brief, diff, rules),
      questions: Object.fromEntries(
        storyDimensions.map((dimension) => [dimension.name, dimensionQuestion(dimension)])
      )
    }),
    post: (result) =>
      dimensionNames.flatMap((name) => {
        const answer = result.answers[name]
        return answer?.type === "score" ? [keyOf(judgeKeys, name).of(answer)] : []
      })
  })
  const decisions = dimensionNames.map((name) =>
    decideRule({
      name: `decide-${name}`,
      answer: keyOf(judgeKeys, name),
      decision: keyOf(decisionKeys, name),
      ...(policy === undefined ? {} : { policy })
    })
  )
  const bar = derive({
    name: "bar",
    condition: all(jProvides, jScope, jStyle, jTests, dProvides, dScope, dStyle, dTests),
    produces: [mergeable, issues],
    derive: ([...values]) => {
      const answers = [values[0], values[1], values[2], values[3]]
      const verdicts = [values[4], values[5], values[6], values[7]]
      const found: Array<ReviewIssue> = []
      dimensionNames.forEach((name, index) => {
        const answer = answers[index]
        const verdict = verdicts[index]
        if (answer === undefined || answer.type !== "score" || verdict === undefined) return
        if (answer.score < passingScore) {
          found.push(
            ReviewIssue.make({
              severity: "Critical",
              title: `judge[${"${brief}"}]: ${name} scored ${answer.score.toFixed(1)}`,
              description: levelDescription(answer)
            })
          )
        } else if (verdict !== "act") {
          found.push(
            ReviewIssue.make({
              severity: "Critical",
              title: `judge[${"${brief}"}]: unsure about ${name}`,
              description: `the judge's ${verdict} decision (certainty ${certaintyOf(answer).toFixed(2)}, support ${answer.support.toFixed(2)}) is below the bar for acting on it`
            })
          )
        }
      })
      return [mergeable.of(found.length === 0), issues.of(found)]
    }
  })
  return makeRuleset({
    name: "story-board",
    imports: [storyBrief, storyDiff, houseRules],
    exports: [mergeable, issues],
    rules: [storyJudge, ...decisions, bar]
  })
}
```

The issue titles need the story id, which `bar` does not read. Give `bar` the brief: add `storyBrief` to its `all(...)` as the first key (nine reads; `all` has overloads up to eight — add a ninth overload to `packages/core/src/blackboard/Rule.ts`? No: core is not touched in this plan). **Instead**, post the story id as part of the judge's output: not possible either without a new key. **Resolution:** derive the issues without the id in `bar` (`title: "<name> scored 1.0"`), and let the adapter prefix `judge[<id>]: ` when it builds the `ReviewResult` — the adapter knows the story. Change the two `title:` lines to `` `${name} scored ${answer.score.toFixed(1)}` `` and `` `unsure about ${name}` ``, and drop the `"${brief}"` placeholders. The tests above expect the prefixed titles from the adapter, which is where the prefix is added. Replace the `throw` in `makeStoryBoard` with returning `Effect.fail(RulesetInvalid.make({ name: "story-board", problems: [{ kind: "UnproducedExport", key: "story.mergeable" }] }))` if you prefer a typed failure; either way it is unreachable while `storyDimensions` has four entries.

The adapter:

```ts
export interface BoardStoryJudgeContext extends StoryJudgeContext {
  readonly judgment: JudgmentShape
  readonly policy?: JudgmentPolicy
}

/** The seam implementation: the ruleset built once, run per judge round. */
export const boardStoryJudge = (
  context: BoardStoryJudgeContext
): Effect.Effect<StoryJudge, FlowError> =>
  Effect.map(
    makeStoryBoard(context.policy).pipe(Effect.mapError(runErrorToFlowError)),
    (board): StoryJudge =>
      (story, diff, seats) =>
        Effect.gen(function* () {
          const judgment = seats.context.judgment ?? context.judgment
          const capped = cap(diff, context.budget).text
          const result = yield* runRuleset(board, [
            storyBrief.of(storyBriefOf(story, context.plan)),
            storyDiff.of(capped),
            houseRules.of(context.houseRules)
          ]).pipe(
            Effect.provide(Layer.succeed(Judgment, judgment)),
            Effect.mapError((error) =>
              runErrorToFlowError(
                error._tag === "ExportsMissing"
                  ? {
                      ...error,
                      message: `story-board: the judge could not score ${error.missing.flatMap((m) => m.waitingRules.flatMap((w) => w.missingKeys)).join(", ")} for ${story.id}`
                    }
                  : error
              )
            )
          )
          yield* publishBlackboardRun(context.events, "story-board", result)
          const isMergeable = yield* result.board.get(mergeable)
          const found = yield* result.board.get(issues)
          for (const name of dimensionNames) {
            const answer = yield* result.board.get(keyOf(judgeKeys, name))
            if (answer.type !== "score") continue
            yield* publishJudgmentObserved(
              context.events,
              JudgmentObserved.make({
                consumer: "story-board",
                key: name,
                state: stateOf(storyBriefOf(story, context.plan), capped, context.houseRules),
                question: dimensionQuestion(storyDimensions.find((d) => d.name === name)!),
                answer,
                judgmentIdentity: judgment.identity,
                decision: decide(answer, context.policy),
                certainty: certaintyOf(answer),
                support: answer.support,
                origin: answer.origin,
                outcome: {
                  _tag: "StoryBoard",
                  dimension: name,
                  score: answer.score,
                  mergeable: isMergeable
                },
                mode: "act"
              })
            )
          }
          return ReviewResult.make({
            issues: found.map((issue) =>
              ReviewIssue.make({ ...issue, title: `judge[${story.id}]: ${issue.title}` })
            ),
            summary: `story-board:${story.id}`
          })
        })
  )
```

Two things to fix while typing this in: (1) spreading a `TaggedError` (`{ ...error, message }`) does not produce an `ExportsMissing`; instead compute the missing dimension names first and build the `FlowError` directly: `FlowLlmError.from(ProviderError.make({ message: "story-board: the judge could not score <dims> for <id>" }))` for `ExportsMissing`, `runErrorToFlowError(error)` otherwise — import `FlowLlmError` and `ProviderError` as `Blackboard.ts` does. The missing dimension names are `missingKeys` with the `judge.` prefix stripped. (2) `storyDimensions.find(...)!` is a non-null assertion; look the dimension up once per name into a `Map` at module load, or iterate `storyDimensions` directly (each has `.name`) instead of `dimensionNames`. `board.get` of a missing `judge.<dim>` cannot happen after a successful run (the bar read all four), so it is fine to `yield*` it; a `MissingFact` there is a defect worth surfacing, so map it with `Effect.orDie`.

- [ ] **Step 4: Run the tests, verify, commit**

Run: `pnpm vitest run flows/test/story-board.test.ts flows/test/epic-stories.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all PASS; clean.

```bash
git add flows/lib/story-board.ts flows/test/story-board.test.ts
git commit -m "story board: the per-story mergeable decision as a ruleset, plugged into the judge seam

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The `epic-stories-board` flow entry, docs and changelog

**Files:**

- Create: `flows/epic-stories-board.ts`
- Modify: `flows/package.json` (`scripts`: add `"epic-stories-board": "node --experimental-strip-types epic-stories-board.ts"` after `"epic-stories"`)
- Modify: `flows/README.md` (new subsection after the `epic-stories` section's bullet list, before `### A pool of executors`)
- Modify: `CHANGELOG.md` (new `## Unreleased` entry at the top)
- Test: `flows/test/story-board.test.ts` (one appended test)

**Interfaces:**

- Consumes: `runEpicStories`, `StoryJudgeContext` (Task 2); `boardStoryJudge` (Task 3); `judgmentOf` (`@llm4ts/flow/Judgment`).
- Produces: `boardJudgeFactory(context: StoryJudgeContext): StoryJudge` in `flows/lib/story-board.ts` — resolves the judgment seat from the run context and builds the board judge; the flow entry passes it to `runEpicStories`.

- [ ] **Step 1: Write the failing test**

Append to `flows/test/story-board.test.ts`:

```ts
describe("the fork entry", () => {
  it("both flow entries run the shared program; the fork's first line names it a fork", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const original = readFileSync(join(here, "..", "epic-stories.ts"), "utf8")
    const fork = readFileSync(join(here, "..", "epic-stories-board.ts"), "utf8")
    assert.include(original, "runEpicStories({ storyJudge: rubricStoryJudge })")
    assert.include(fork, "runEpicStories({ storyJudge: boardJudgeFactory })")
    assert.match(fork.split("\n")[0] ?? "", /^\/\/ .*fork of epic-stories/)
  })
})
```

(with `readFileSync` from `node:fs`, `dirname`/`join` from `node:path`, `fileURLToPath` from `node:url` added to the imports). This pins Review Focus 4: the two entries differ only in the judge.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run flows/test/story-board.test.ts -t "fork entry"`
Expected: FAIL — `epic-stories-board.ts` does not exist.

- [ ] **Step 3: Add the factory, the flow entry, the script**

Append to `flows/lib/story-board.ts`:

```ts
import { judgmentOf } from "@llm4ts/flow/Judgment" // move to the import block

/**
 * The judge `epic-stories-board` passes to runEpicStories: the run's judgment
 * seat (LLM4TS_JUDGMENT_PROVIDER, or one derived from the reasoning seat),
 * the default policy. Building the ruleset cannot fail while the four
 * dimensions are fixed, so a failure here is a defect.
 */
export const boardJudgeFactory =
  (context: StoryJudgeContext): StoryJudge =>
  (story, diff, seats) =>
    Effect.flatMap(boardStoryJudge({ ...context, judgment: judgmentOf(seats.context) }), (judge) =>
      judge(story, diff, seats)
    )
```

Note this builds the ruleset per call rather than once per run; `makeRuleset` is validation over six rules (microseconds) and keeps the factory's type the simple `StoryJudge`. If you prefer once-per-run, memoize with a module-level `Effect.cached` — not required.

Create `flows/epic-stories-board.ts`:

```ts
// A fork of epic-stories that judges each story with a blackboard ruleset (ADR 0020): the four story dimensions are scored by the Judgment service, decided by the run's judgment policy, and a company-editable bar in flows/lib/story-board.ts says whether the story merges. Same flags and environment as epic-stories.
//
//   llm4ts run epic-stories-board --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-stories-board --repo ~/demo/portal -- --plan-only "…"
//
// The judgment seat is LLM4TS_JUDGMENT_PROVIDER / LLM4TS_JUDGMENT_MODEL (ADR
// 0017), or one derived from the reasoning seat. Each round's run lands in
// the trace as a BlackboardRun event and each answer in
// .llm4ts/judgments/story-board.jsonl. Until this judge is approved,
// epic-stories keeps the rubric judge.
import { runFlowMain } from "@llm4ts/runner"
import { runEpicStories } from "./lib/epic-stories.ts"
import { boardJudgeFactory } from "./lib/story-board.ts"

runFlowMain(runEpicStories({ storyJudge: boardJudgeFactory }))
```

Add the script to `flows/package.json`.

- [ ] **Step 4: Docs**

In `flows/README.md`, before `### A pool of executors`, add:

```markdown
### The story judge as a ruleset (fork)

`epic-stories-board` is `epic-stories` with one difference: each story is
judged by a blackboard ruleset (ADR 0020, `flows/lib/story-board.ts`)
instead of the rubric judge. A `judge` rule scores the four dimensions
(provides, scope, house-style, tests) with the Judgment service; `decide`
turns each answer into act, caution or hold; and the `bar` rule merges the
story only when every dimension scores at least 1.5 of 2 **and** is an
`act`. Anything else comes back to the coder as issues, one per dimension.
Every round's run is in the trace (`BlackboardRun`) and every answer in
`.llm4ts/judgments/story-board.jsonl`. Same flags and environment as
`epic-stories`; the judgment seat is `LLM4TS_JUDGMENT_PROVIDER` /
`LLM4TS_JUDGMENT_MODEL`, or the reasoning seat.
```

At the top of `CHANGELOG.md`, below `# Changelog`:

```markdown
## Unreleased

- `epic-stories-board`: a fork of `epic-stories` whose story judge is a
  blackboard ruleset (`flows/lib/story-board.ts`): four Score judgments,
  `decide`, and a company-editable bar (score ≥ 1.5 and `act` on every
  dimension). The run is a `BlackboardRun` trace event; answers are logged
  under the `story-board` judgment consumer. `epic-stories` is unchanged;
  its program is now `runEpicStories({ storyJudge })`.
- `@llm4ts/flow/Blackboard`: `decideRule`, `answerKey`/`decisionKey`,
  `publishBlackboardRun`, `runErrorToFlowError`.
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green.

```bash
git add flows/epic-stories-board.ts flows/lib/story-board.ts flows/package.json flows/README.md CHANGELOG.md flows/test/story-board.test.ts
git commit -m "epic-stories-board: fork flow with the ruleset story judge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Published surface

**Files:**

- None new; verification only (the shell's `sync-shell-flows.mjs` copies every `flows/*.ts` and its `lib/`, so the fork ships automatically).

- [ ] **Step 1: Build and smoke**

Run: `pnpm build && node scripts/pack-smoke.mjs`
Expected: `pack smoke: llm4ts bin listed 26 built-in flow(s)` (one more than today's 25) and the two other `pack smoke:` lines. If the count is still 25, `scripts/sync-shell-flows.mjs` or the shell's `FlowCatalog` filters flows by name or by a list; add `epic-stories-board` where `epic-stories` is listed.

- [ ] **Step 2: Catalog description**

Run: `node packages/shell/dist/bin.js list --json 2>/dev/null | grep -o '"epic-stories-board[^}]*' | head -1` (adjust the bin path to what `packages/shell/package.json` `bin` names)
Expected: the fork appears with the description from its first comment line.

- [ ] **Step 3: Nothing to commit unless Step 1 needed a change**

If it did:

```bash
git add scripts/sync-shell-flows.mjs packages/shell/src
git commit -m "shell: ship epic-stories-board beside epic-stories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: `Blackboard.ts` helpers and the event/consumer/outcome additions (T1); `runEpicStories` with the one changed line and `rubricStoryJudge` (T2); the ruleset (imports, six rules, bar, issue titles) and the adapter with `BlackboardRun` + `JudgmentObserved` (T3); the fork entry, README, CHANGELOG (T4); shipping (T5). The spec's "the ruleset is built once per flow run" is relaxed to once per judge call in `boardJudgeFactory` (validation is microseconds; noted in T4) — record this in the CHANGELOG line only if it matters to a reader; otherwise it is an implementation detail.
- Deviation from the spec worth noting to the executor: the issue-title prefix `judge[<id>]: ` is added by the adapter, not the `bar` rule, because `bar` reads eight facts and `all` is typed up to eight keys; the bar's titles are `<dim> scored <n>` / `unsure about <dim>`.
- Names used consistently: `answerKey`, `decisionKey`, `decideRule`, `runErrorToFlowError`, `publishBlackboardRun`, `BlackboardRun`, `StoryJudge`, `StoryJudgeContext`, `rubricStoryJudge`, `runEpicStories`, `EpicStoriesOptions`, `StoryBrief`, `storyBriefOf`, `makeStoryBoard`, `boardStoryJudge`, `BoardStoryJudgeContext`, `boardJudgeFactory`, `passingScore`, `dimensionNames`, `storyBrief`, `storyDiff`, `houseRules`, `mergeable`, `issues`, `judgeKeys`, `decisionKeys`.
- Review Focus pinned: 1 → T3 "could not score"; 2 → T3 "unsure"; 3 → T3 "exactly 1.5"; 4 → T4 fork-entry test; 5 → T1 event round trip.
