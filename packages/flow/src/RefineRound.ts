// Refine rounds (ADR 0021): follow-up stories on a finished epic, planned
// from feedback. A round is its own story plan on the epic's branch, so the
// executor and the ownership rule are the ones a plan has. Pure: reading the
// round folders and asking the planner belong to the flow.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { Story, StoryPlan } from "./StoryPlan.ts"

/** A feedback item the planner left out, with the reason or the question to answer. */
export class NotPlanned extends Schema.Class<NotPlanned>("NotPlanned")({
  item: Schema.String,
  reason: Schema.String
}) {}

/** What the planner returns for a round: the stories it can place, and the rest. */
export class RefineProposal extends Schema.Class<RefineProposal>("RefineProposal")({
  stories: Schema.Array(Story),
  notPlanned: Schema.Array(NotPlanned).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  )
}) {}

const strings: JsonSchema = { type: "array", items: { type: "string" } }

export const refineProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: strings,
          owned: strings,
          sharedReadOnly: strings,
          readFirst: strings,
          acceptance: strings,
          provides: strings
        },
        required: [
          "id",
          "title",
          "description",
          "dependsOn",
          "owned",
          "sharedReadOnly",
          "readFirst",
          "acceptance",
          "provides"
        ]
      }
    },
    notPlanned: {
      type: "array",
      items: {
        type: "object",
        properties: { item: { type: "string" }, reason: { type: "string" } },
        required: ["item", "reason"]
      }
    }
  },
  required: ["stories", "notPlanned"]
}

/** Round stories are `r<n>-…`: unique across the epic, whatever the planner called them. */
export const roundPrefix = (round: number): string => `r${round}-`

/**
 * The round's story plan from a proposal. Ids get the round's prefix (once),
 * dependencies follow, and a dependency on a story merged before the round
 * (`earlier`) is dropped: a round only starts once those are in the branch.
 */
export const assembleRound = (inputs: {
  readonly epicId: string
  readonly round: number
  readonly feedback: string
  readonly proposal: RefineProposal
  /** Ids of every story of the epic's plan and of the earlier rounds. */
  readonly earlier: ReadonlyArray<string>
}): StoryPlan => {
  const prefix = roundPrefix(inputs.round)
  const prefixed = (id: string): string => (id.startsWith(prefix) ? id : `${prefix}${id}`)
  const own = new Set(inputs.proposal.stories.map((story) => story.id))
  const earlier = new Set(inputs.earlier)
  return StoryPlan.make({
    epicId: inputs.epicId,
    epic: inputs.feedback,
    stories: inputs.proposal.stories.map((story) =>
      Story.make({
        ...story,
        id: prefixed(story.id),
        dependsOn: story.dependsOn
          .filter((dependency) => own.has(dependency) || !earlier.has(dependency))
          .map(prefixed)
      })
    )
  })
}

/** What to do about a round whose plan cannot be read: a plan alone is never deleted. */
export const roundRepair = (round: number): string =>
  `fix the plan, or delete the folder rounds/${round} and every later round`

/** A round as the run decision sees it. */
export interface RoundProgress {
  readonly round: number
  readonly stories: number
  readonly merged: number
  /** Why its plan cannot be read, naming the file. */
  readonly unreadable?: string
}

export type RunAction =
  | { readonly _tag: "RunPlan" }
  | { readonly _tag: "RunRound"; readonly round: number }
  | { readonly _tag: "PlanRound"; readonly round: number }
  | { readonly _tag: "Land" }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Usage"; readonly message: string }

export interface RunInputs {
  /** The epic has a story plan. */
  readonly planned: boolean
  readonly stories: number
  readonly merged: number
  /** The branch the epic landed on, once it has. */
  readonly landed: string | undefined
  readonly rounds: ReadonlyArray<RoundProgress>
  /** `--refine` was given. */
  readonly refine: boolean
  /** The text given with `--refine`. */
  readonly feedback: string
  /** `--land` was given. */
  readonly land: boolean
}

/**
 * What a run of the epic does: its plan's stories, the open round, a new
 * round, or the landing. A round starts only when everything before it is
 * merged, and an open round is finished before another is planned.
 */
export const runAction = (inputs: RunInputs): RunAction => {
  if (inputs.land) {
    // Landing with feedback in hand would drop the feedback for good.
    return inputs.refine && inputs.feedback.trim().length > 0
      ? {
          _tag: "Usage",
          message:
            "--refine with feedback and --land do not go together: run the round first, then land"
        }
      : { _tag: "Land" }
  }
  const planOpen = inputs.merged < inputs.stories
  const unreadable = inputs.rounds.find((round) => round.unreadable !== undefined)
  const open = inputs.rounds.find((round) => round.merged < round.stories)
  const broken = (round: RoundProgress): RunAction => ({
    _tag: "Refused",
    reason: `round ${round.round}'s plan cannot be read (${round.unreadable ?? ""}); ${roundRepair(round.round)}`
  })
  if (!inputs.refine) {
    if (planOpen) {
      return { _tag: "RunPlan" }
    }
    if (unreadable !== undefined) {
      return broken(unreadable)
    }
    return open === undefined ? { _tag: "RunPlan" } : { _tag: "RunRound", round: open.round }
  }
  if (!inputs.planned) {
    return { _tag: "Refused", reason: "it has no story plan yet: run the epic first" }
  }
  if (inputs.landed !== undefined) {
    return {
      _tag: "Refused",
      reason: `it has landed on ${inputs.landed}; give the changes as a new epic`
    }
  }
  if (unreadable !== undefined) {
    return broken(unreadable)
  }
  if (planOpen) {
    return {
      _tag: "Refused",
      reason: `${inputs.merged} of ${inputs.stories} stories merged: rerun the epic until every story merges`
    }
  }
  const feedback = inputs.feedback.trim()
  if (open !== undefined) {
    return feedback.length === 0
      ? { _tag: "RunRound", round: open.round }
      : {
          _tag: "Refused",
          reason: `round ${open.round} is open (${open.merged} of ${open.stories} stories merged): rerun without --refine text to finish it, or edit its plan`
        }
  }
  if (feedback.length === 0) {
    return { _tag: "Usage", message: "--refine needs the feedback to plan a round from" }
  }
  return { _tag: "PlanRound", round: inputs.rounds.length + 1 }
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** `not-planned.md`: one line per item left out, for the person and for the next round's planner. */
export const renderNotPlanned = (round: number, items: ReadonlyArray<NotPlanned>): string =>
  [
    `# Not planned in round ${round}`,
    "",
    ...(items.length === 0
      ? ["Every feedback item was planned."]
      : items.map((entry) => `- **${oneLine(entry.item)}** — ${oneLine(entry.reason)}`)),
    ""
  ].join("\n")

export const countNotPlanned = (markdown: string): number =>
  markdown.split("\n").filter((line) => line.startsWith("- **")).length

/** An earlier story as a round's planner is shown it: what was built, and where. */
export interface EarlierStory {
  readonly id: string
  readonly title: string
  readonly owned: ReadonlyArray<string>
  readonly provides: ReadonlyArray<string>
}

export const earlierStories = (plans: ReadonlyArray<StoryPlan>): ReadonlyArray<EarlierStory> =>
  plans.flatMap((plan) =>
    plan.stories.map((story) => ({
      id: story.id,
      title: story.title,
      owned: story.owned,
      provides: story.provides
    }))
  )
