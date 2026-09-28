import type * as Effect from "effect/Effect"
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
