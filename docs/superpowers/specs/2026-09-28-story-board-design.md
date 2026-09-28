# Story board: the per-story mergeable decision as a ruleset

Date: 2026-09-28 · Status: design agreed in conversation, spec for review

## Purpose

The first consumer of the typed blackboard (ADR 0020,
`docs/superpowers/specs/2026-09-27-blackboard-design.md`). In
`epic-stories`, a story branch is judged before it merges into the epic
branch: today a rubric judge (`judgeStory`, four `Dimension`s scored by
`@llm4ts/core/eval/Judge`) returns a `ReviewResult`, and the story merges
when `isClean`. That bar lives in code a company cannot edit, and the model's
verdict and the deterministic checks are not separable.

This spec re-expresses that decision as a ruleset: deterministic rules gate
a `judge` rule that asks the `Judgment` service typed questions; `decide`
turns each answer into `act | caution | hold`; a `bar` rule the company owns
posts `mergeable` and the issues the coder gets back. The result flows into
the existing story loop through its `judge` seam, unchanged.

Because the ruleset judge is unproven, it ships as a **fork**: a second flow
entry, `epic-stories-board`, beside `epic-stories`. The approved flow keeps
its behaviour, tests and defaults. When the ruleset judge is approved, the
fork collapses into a default.

## Decisions taken

1. **Fork by sharing the program and swapping the judge** (option A). The
   program body of `flows/epic-stories.ts` moves, unchanged, into
   `flows/lib/epic-stories.ts` as `runEpicStories(options)`, with the story
   judge as an option. `flows/epic-stories.ts` passes today's `judgeStory`;
   `flows/epic-stories-board.ts` passes the ruleset judge. No copy of the
   flow, no env switch on the approved path.
2. **The decision is the per-story "mergeable" verdict**, one per judge
   round. The loop (coder feedback, retry, perimeter enforcement, gates,
   merge) stays in `packages/flow/src/Stories.ts`, untouched.
3. **The bar**: mergeable iff every dimension's expected score is at least
   1.5 (of 2) **and** its decision is `act`. Any other dimension produces
   one issue. A `hold` produces an "unsure" issue and counts as a
   not-cleared round, as today's sub-bar verdict does.
4. **Policy stays in flow.** `decideRule` lives in `@llm4ts/flow`, over
   `decide` and `JudgmentPolicy`; core is not touched.
5. **The run is recorded through an event.** A `BlackboardRun` FlowEvent
   carries the encoded `RunResult`; `FlowRecorder` writes every event, so
   no recorder change. Each judgment answer is also published as a
   `JudgmentObserved` with a new consumer `story-board`, so the existing
   judgment log and the eval tooling see it.

## Components

```text
packages/flow/src/Blackboard.ts        decideRule, BlackboardRun event helpers
packages/flow/src/FlowEvents.ts        BlackboardRun event; consumer "story-board";
                                       JudgmentOutcome "StoryBoard"
flows/lib/story-board.ts               the ruleset (company-editable) + adapter
flows/lib/epic-stories.ts              runEpicStories(options) — the moved program
flows/epic-stories.ts                  runEpicStories({ judge: judgeStory-based })
flows/epic-stories-board.ts            runEpicStories({ judge: judgeStoryByRules })
```

### `packages/flow/src/Blackboard.ts`

- `decideRule(options: { name; answer: FactKey<Answer>; decision: FactKey<Decision>; policy?: JudgmentPolicy })` → a `derive` rule reading the answer and posting `decide(answer, policy)`. Exported for any ruleset.
- `AnswerKey(name)` / `DecisionKey(name)`: `makeKey` over the `Answer` and `Decision` schemas, so rulesets don't repeat the schemas.
- `publishBlackboardRun(events, ruleset: string, result: RunResult)` publishes the event below.
- `runErrorToFlowError(error: RunError | RulesetInvalid): FlowError` — a `FlowLlmError`/`PersistenceError`-style typed mapping; the message names rules and keys only.

### `packages/flow/src/FlowEvents.ts`

- `BlackboardRun` TaggedClass `{ ruleset: String, result: RunResult }` (imports `RunResult` from `@llm4ts/core/blackboard/Run`; the schema encodes it as JSON in the trace).
- `JudgmentObserved.consumer` gains `"story-board"`; `JudgmentOutcome` gains `TaggedStruct("StoryBoard", { dimension: String, score: Number, mergeable: Boolean })`.
- `judgmentLogPath` keys on the consumer already, so `story-board.jsonl` needs no change.

### `flows/lib/story-board.ts` — the ruleset

The empty-diff check stays where it is: `Stories.ts` already fails a story
deterministically before it calls the judge seam ("the story branch has no
changes against the epic branch"), so the ruleset assumes a non-empty diff
and never pays a model call for one.

Facts (all `makeKey`):

| Key                | Schema                                                                                                 | Role    |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------- |
| `story.brief`      | `StoryBrief` (id, title, description, provides, owned, sharedReadOnly, dependencies: [{id, provides}]) | import  |
| `story.diff`       | `Schema.String` (already capped by the caller)                                                         | import  |
| `story.houseRules` | `Schema.String`                                                                                        | import  |
| `judge.<dim>`      | `ScoreAnswer` × 4 (`provides`, `scope`, `house-style`, `tests`)                                        | judged  |
| `decision.<dim>`   | `Decision` × 4                                                                                         | derived |
| `story.mergeable`  | `Schema.Boolean`                                                                                       | export  |
| `story.issues`     | `Schema.Array(ReviewIssue)`                                                                            | export  |

Rules:

1. `story-judge` (judge): `all(story.brief, story.diff, story.houseRules)`.
   `ask` builds the State from `storyJudgeQuery`'s text plus the diff (the
   same words the rubric judge reads today) and four **Score** questions,
   one per dimension, whose levels are the dimension's three rubric levels
   (0, 1, 2). Reuse the Dimension→Score construction `ProgramJudge.ts`
   already has (`judgeWithJudgment`); export it rather than duplicate it.
   `post` posts one `judge.<dim>` fact per answered dimension; a dimension
   the backend failed on is not posted.
2. `decide-<dim>` × 4 (`decideRule`): `on(judge.<dim>)` → `decision.<dim>`,
   policy from the caller.
3. `bar` (derive): `all(judge.provides, judge.scope, judge.house-style,
judge.tests, decision.provides, decision.scope, decision.house-style,
decision.tests)` → `story.mergeable` and `story.issues`. Mergeable iff
   every dimension has expected score ≥ 1.5 and decision `act`. Per failing
   dimension one `ReviewIssue` (severity Critical): title
   `judge[<story>]: <dim> scored <score.toFixed(1)>` with the level
   description as body when the score is below the bar; title
   `judge[<story>]: unsure about <dim>` when the score passes but the
   decision is `caution` or `hold`. The coder gets these as feedback, as it
   gets the rubric judge's issues today.

If the backend fails a question, its `judge.<dim>` fact is missing, `bar`
never fires, and the run ends in `ExportsMissing` naming `bar` and the
missing dimension. The adapter maps that to a `FlowError` that says which
dimension the judge could not score: a typed, explained failure instead of
a guess.

Imports: `story.brief`, `story.diff`, `story.houseRules`. Exports:
`story.mergeable`, `story.issues`. Six rules.

### `flows/lib/story-board.ts` — the adapter

```ts
judgeStoryByRules(options: {
  judgment: JudgmentShape          // judgmentOf(seats.context) or the roster's judge seat
  policy?: JudgmentPolicy
  events: FlowEventsShape
  plan?: StoryPlan
  budget: number
  houseRules: string
}): (story: Story, diff: string) => Effect<ReviewResult, FlowError>
```

Per call: cap the diff, build `StoryBrief` (dependencies from `dependenciesOf(plan, story.id)` as `storyJudgeQuery` does), run the ruleset with `runRuleset` providing the `Judgment` layer from `options.judgment`, publish `BlackboardRun`, publish one `JudgmentObserved` per posted answer (`consumer: "story-board"`, `outcome: { _tag: "StoryBoard", dimension, score, mergeable }`, `mode` from the context as `ProgramJudge` does), and return `ReviewResult.make({ issues, summary: "story-board:<id>" })`. `RunError`/`RulesetInvalid` → `FlowError` via `runErrorToFlowError`. The ruleset is built once per flow run (`makeRuleset` at adapter construction), not per story.

### `flows/lib/epic-stories.ts` — `runEpicStories`

The body of `program` in `flows/epic-stories.ts` (lines 94–319 today) moves here verbatim as `runEpicStories(options: { storyJudge: (seats: StorySeats, plan: StoryPlan, budget: number) => StoryJudge })`, where `StoryJudge` is the type of `implementStoriesFlow`'s `judge` option. The one changed line is `judge: options.storyJudge(seats, plan, contextBudget)` in place of the inline `judgeStory` call. `flows/epic-stories.ts` becomes the header comment, `runFlowMain(runEpicStories({ storyJudge: rubricStoryJudge }))`, with `rubricStoryJudge` reproducing today's call (roster judge seat or `reasoningMeter.service`).

`flows/epic-stories-board.ts`: the same, with `storyJudge` building `judgeStoryByRules` from `judgmentOf(seats.context)` (or the roster's `judge` role when present) and the run's `JudgmentPolicy`. Its header comment states that it is a fork of `epic-stories` trialling the ruleset judge, same flags and environment.

`flows/README.md` gets a short subsection under "Parallel stories from an epic" naming the fork and the bar.

## Error handling

- Ruleset construction failure (`RulesetInvalid`) is a programming error in the shipped ruleset; the adapter fails the flow at start with the accumulated problems.
- `ExportsMissing` (a dimension the backend could not score) → `FlowError`, message: `story-board: the judge could not score <dim> for <story>`; the story loop treats it as a judge error, as today.
- Backend unreachable → `RuleFailure` on `story-judge`, no defaults → `ExportsMissing` as above.
- Fact values never appear in error messages (the diff is a fact).

## Testing

- `flows/test/story-board.test.ts` with `FakeJudgment`:
  - all four scores at level 2 → `mergeable`, no issues, one `BlackboardRun` event with a `judge` firing carrying `backend: "fake"`, four `JudgmentObserved` with consumer `story-board`;
  - `scope` at level 1 → not mergeable, one issue titled `judge[<id>]: scope scored 1.0`;
  - a passing score whose decision is `hold` (support below `minSupport`) → one "unsure" issue;
  - a failed question → `FlowError` naming the dimension;
  - the ruleset's `describe()` lists the three imports, two exports and six rules (pinned so a company edit shows up in review).
- `flows/test/epic-stories.test.ts` stays green unchanged (proves the move of the program is behaviour-preserving); one new test asserts `runEpicStories` passes its `storyJudge` through to `implementStoriesFlow` (fake judge called with the story and diff).
- `packages/flow/test/Blackboard.test.ts`: `decideRule` posts `act`/`caution`/`hold` for three canned answers; `BlackboardRun` round-trips through its schema.
- No network; default CI unchanged.

## Out of scope

Perimeter and gates as rules (they run at other points of the loop);
escalating `hold` answers to the reasoning seat (`judgeOrEscalate` exists,
wiring it is a follow-up); the landing decision; replacing `epic-stories`'
default judge (that is the approval decision this fork exists to inform).
