// epic-draft (ADR 0043): the epic-stories spine with tests and validation
// deferred, not dropped. A draft run plans and builds without tests, under
// one review lens and the build gates; what it deferred is written to
// debt.md, and `--harden` plans that debt as a round under the full bar.
import * as Effect from "effect/Effect"
import type { FlowLlmError } from "@llm4ts/flow/FlowError"
import { StoryPlan } from "@llm4ts/flow/StoryPlan"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { storyPlanInstructions, storyPlanJsonSchema, type PlanInputs } from "./epic-stories.ts"

// ---- The draft plan ---------------------------------------------------------

/** The epic-stories planner's rules, then the draft cut on top. */
export const draftPlanInstructions = (
  epicId: string,
  guidance: string,
  orientation?: string
): string =>
  [
    storyPlanInstructions(epicId, guidance, orientation),
    "",
    "Draft cut (this run is epic-draft: working code first, tests and validation in a later",
    "hardening round). These rules override the ones above where they differ:",
    "- No story writes or owns test files now; leave them out of `owned`.",
    "- `acceptance` still lists two to six outcomes per story: each one is a test the hardening",
    "  round will write, so make each checkable by an automated test.",
    "- Prefer fewer, thinner stories: the shortest path to working code.",
    "- Leave `testsDeferred` out: every outcome's test is owed and planned later."
  ].join("\n")

/** The draft planner: the epic-stories plan under the draft cut. */
export const generateDraftPlan = (inputs: PlanInputs): Effect.Effect<StoryPlan, FlowLlmError> =>
  structuredAndPublish(
    inputs.reasoning,
    inputs.events,
    `${draftPlanInstructions(inputs.epicId, inputs.guidance, inputs.orientation)}\n\nEpic:\n${inputs.brief ?? inputs.epic}`,
    StoryPlan,
    storyPlanJsonSchema
  ).pipe(
    // The id and the epic text are ours, whatever the model echoed back.
    Effect.map((plan) => StoryPlan.make({ ...plan, epicId: inputs.epicId, epic: inputs.epic }))
  )
