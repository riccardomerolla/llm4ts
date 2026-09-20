import * as Schema from "effect/Schema"

/**
 * The two literals shared by the judgment policy and the flow events. They
 * live apart from `Judgment.ts` so `FlowEvents.ts` can import them without
 * a module cycle (the policy module publishes events).
 */

/** Consumers observe by default; automation requires an explicit act mode. */
export const JudgmentMode = Schema.Literals(["observe", "advise", "act"])
export type JudgmentMode = typeof JudgmentMode.Type

/** The three bands Jev documents: act, proceed with caution, or hold. */
export const Decision = Schema.Literals(["act", "caution", "hold"])
export type Decision = typeof Decision.Type
