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
import { runRuleset, type ExportsMissing, type RunResult } from "@llm4ts/core/blackboard/Run"
import { makeRuleset, type Ruleset, type RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { ProviderError } from "@llm4ts/core/Errors"
import { dimensionQuestion } from "@llm4ts/core/eval/Judge"
import type { Dimension } from "@llm4ts/core/eval/Eval"
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
import { FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { JudgmentObserved, publishJudgmentObserved } from "@llm4ts/flow/FlowEvents"
import { certaintyOf, decide, judgmentOf, type JudgmentPolicy } from "@llm4ts/flow/Judgment"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { dependenciesOf, type Story, type StoryPlan } from "@llm4ts/flow/StoryPlan"
import { storyDimensions, type StoryJudge, type StoryJudgeContext } from "./epic-stories.ts"

export class StoryBrief extends Schema.Class<StoryBrief>("StoryBrief")({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  acceptance: Schema.Array(Schema.String),
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
    acceptance: story.acceptance,
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

// ---- Facts ------------------------------------------------------------------

export const storyBrief = makeKey("story.brief", StoryBrief)
export const storyDiff = makeKey("story.diff", Schema.String)
export const houseRules = makeKey("story.houseRules", Schema.String)
export const mergeable = makeKey("story.mergeable", Schema.Boolean)
export const issues = makeKey("story.issues", Schema.Array(ReviewIssue))

/** One judged answer and one decision per story dimension, keyed by the dimension's name. */
const judged = (name: string) => answerKey(`judge.${name}`)
const decided = (name: string) => decisionKey(`decision.${name}`)
const [provides, scope, houseStyle, tests] = storyDimensions.map((dimension) => ({
  dimension,
  answer: judged(dimension.name),
  decision: decided(dimension.name)
}))
if (
  provides === undefined ||
  scope === undefined ||
  houseStyle === undefined ||
  tests === undefined
) {
  throw new Error("story board: storyDimensions must have four entries")
}
const dimensions = [provides, scope, houseStyle, tests]
export const dimensionNames: ReadonlyArray<string> = dimensions.map((d) => d.dimension.name)

/** Expected level (of 2) a dimension must reach; the company's bar. */
export const passingScore = 1.5

/** The State the judge reads: the same words as the rubric judge, brief then diff. */
export const stateOf = (brief: StoryBrief, diff: string, rules: string): string =>
  [
    `Story: ${brief.title}`,
    brief.description,
    ...(brief.acceptance.length === 0
      ? []
      : [
          "",
          "Done when (the story's acceptance criteria — `provides` is scored against them too):",
          ...brief.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`)
        ]),
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

const levelDescription = (answer: ScoreAnswer): string => {
  const rounded = String(Math.max(0, Math.min(2, Math.round(answer.score))))
  const legend = answer.legend[rounded]
  return typeof legend === "string" ? legend : JSON.stringify(legend ?? "")
}

// ---- The ruleset ------------------------------------------------------------

export const makeStoryBoard = (
  policy?: JudgmentPolicy
): Effect.Effect<Ruleset<JudgmentBackendError, Judgment>, RulesetInvalid> => {
  const storyJudge = judge({
    name: "story-judge",
    condition: all(storyBrief, storyDiff, houseRules),
    produces: dimensions.map((d) => d.answer),
    ask: ([brief, diff, rules]) => ({
      state: stateOf(brief, diff, rules),
      questions: Object.fromEntries(
        dimensions.map((d) => [d.dimension.name, dimensionQuestion(d.dimension)])
      )
    }),
    post: (result) =>
      dimensions.flatMap((d) => {
        const answer = result.answers[d.dimension.name]
        return answer?.type === "score" ? [d.answer.of(answer)] : []
      })
  })
  const decisions = dimensions.map((d) =>
    decideRule({
      name: `decide-${d.dimension.name}`,
      answer: d.answer,
      decision: d.decision,
      ...(policy === undefined ? {} : { policy })
    })
  )
  const bar = derive({
    name: "bar",
    condition: all(
      provides.answer,
      scope.answer,
      houseStyle.answer,
      tests.answer,
      provides.decision,
      scope.decision,
      houseStyle.decision,
      tests.decision
    ),
    produces: [mergeable, issues],
    derive: ([a1, a2, a3, a4, v1, v2, v3, v4]) => {
      const found: Array<ReviewIssue> = []
      const answers = [a1, a2, a3, a4]
      const verdicts = [v1, v2, v3, v4]
      dimensions.forEach((d, index) => {
        const answer = answers[index]
        const verdict = verdicts[index]
        if (answer === undefined || verdict === undefined || answer.type !== "score") return
        if (answer.score < passingScore) {
          found.push(
            ReviewIssue.make({
              severity: "Critical",
              title: `${d.dimension.name} scored ${answer.score.toFixed(1)}`,
              description: levelDescription(answer)
            })
          )
        } else if (verdict !== "act") {
          found.push(
            ReviewIssue.make({
              severity: "Critical",
              title: `unsure about ${d.dimension.name}`,
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

// ---- The adapter: the judge seam of implementStoriesFlow ---------------------

export interface BoardStoryJudgeContext extends StoryJudgeContext {
  readonly judgment: JudgmentShape
  readonly policy?: JudgmentPolicy
}

/**
 * The round's error when the bar never fired: which dimensions went unscored
 * and, when the backend itself failed, its message — the story loop reads an
 * outage off that message and waits for recovery instead of failing the story.
 */
const unscored = (story: string, error: ExportsMissing): FlowError => {
  const names = [
    ...new Set(
      error.missing
        .flatMap((m) => m.waitingRules.flatMap((w) => w.missingKeys))
        .filter((key) => key.startsWith("judge."))
        .map((key) => key.slice("judge.".length))
    )
  ]
  const because = error.failures.map((failure) => `${failure.tag}: ${failure.message}`)
  return FlowLlmError.from(
    ProviderError.make({
      message: `story-board: the judge could not score ${names.join(", ")} for ${story}${
        because.length === 0 ? "" : ` (${because.join("; ")})`
      }`
    })
  )
}

/** The seam implementation: the ruleset built once, run per judge round. */
export const boardStoryJudge = (
  context: BoardStoryJudgeContext
): Effect.Effect<StoryJudge, FlowError> =>
  Effect.map(
    makeStoryBoard(context.policy).pipe(Effect.mapError(runErrorToFlowError)),
    (board): StoryJudge =>
      (story, diff, seats, subject) =>
        Effect.gen(function* () {
          const judgment = seats.context.judgment ?? context.judgment
          const brief = storyBriefOf(story, context.plan)
          // A branch with no changes is judged on its owned code, said so up front.
          const capped = `${
            subject === "code"
              ? "The story's branch has no changes; this is the current code of its owned paths on the epic branch.\n"
              : ""
          }${cap(diff, context.budget).text}`
          const result = yield* runRuleset(board, [
            storyBrief.of(brief),
            storyDiff.of(capped),
            houseRules.of(context.houseRules)
          ]).pipe(
            Effect.provide(Layer.succeed(Judgment, judgment)),
            Effect.mapError((error) =>
              error._tag === "ExportsMissing"
                ? unscored(story.id, error)
                : runErrorToFlowError(error)
            )
          )
          yield* publishBlackboardRun(context.events, "story-board", result)
          const isMergeable = yield* result.board.get(mergeable).pipe(Effect.orDie)
          const found = yield* result.board.get(issues).pipe(Effect.orDie)
          const state = stateOf(brief, capped, context.houseRules)
          for (const d of dimensions) {
            yield* observe(context, judgment, d.dimension, state, result, isMergeable, d.answer)
          }
          return ReviewResult.make({
            issues: found.map((issue) =>
              ReviewIssue.make({ ...issue, title: `judge[${story.id}]: ${issue.title}` })
            ),
            summary: `story-board:${story.id}`
          })
        })
  )

const observe = (
  context: BoardStoryJudgeContext,
  judgment: JudgmentShape,
  dimension: Dimension,
  state: string,
  result: RunResult,
  isMergeable: boolean,
  key: FactKey<Answer>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // The bar read every answer, so a missing one after a successful run is a defect.
    const answer = yield* result.board.get(key).pipe(Effect.orDie)
    if (answer.type !== "score") return
    yield* publishJudgmentObserved(
      context.events,
      JudgmentObserved.make({
        consumer: "story-board",
        key: dimension.name,
        state,
        question: dimensionQuestion(dimension),
        answer,
        judgmentIdentity: judgment.identity,
        decision: decide(answer, context.policy),
        certainty: certaintyOf(answer),
        support: answer.support,
        origin: answer.origin,
        outcome: {
          _tag: "StoryBoard",
          dimension: dimension.name,
          score: answer.score,
          mergeable: isMergeable
        },
        mode: "act"
      })
    )
  })

/**
 * The judge `epic-stories-board` passes to runEpicStories: the run's judgment
 * seat (LLM4TS_JUDGMENT_PROVIDER, or one derived from the reasoning seat),
 * the default policy. Validating six rules is microseconds, so the ruleset
 * is built per call and the factory keeps the plain StoryJudge type.
 */
export const boardJudgeFactory =
  (context: StoryJudgeContext): StoryJudge =>
  (story, diff, seats, subject) =>
    Effect.flatMap(boardStoryJudge({ ...context, judgment: judgmentOf(seats.context) }), (judge) =>
      judge(story, diff, seats, subject)
    )
