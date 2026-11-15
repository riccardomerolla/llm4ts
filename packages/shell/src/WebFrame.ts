// @internal: the wire format of `llm4ts watch --web`, shared by its server and its page
import * as Schema from "effect/Schema"

/**
 * What travels between `llm4ts watch --web` and its page (ADR 0051): the run
 * the page first asks for, and the frames it draws. The server encodes
 * through these schemas and the page decodes every response and every
 * streamed frame through them. Browser-safe: this module imports only
 * `effect/Schema`, so the page's bundle carries it.
 */

/** How a timeline item is coloured: the tree's styles, and the node states. */
export const WebTone = Schema.Literals([
  "orchestrator",
  "judgment",
  "judge",
  "running",
  "log",
  "tool",
  "done",
  "failed",
  "issue"
])
export type WebTone = typeof WebTone.Type

export const WebChipStatus = Schema.Literals(["planned", "running", "waiting", "done", "failed"])
export type WebChipStatus = typeof WebChipStatus.Type

export const WebTimelineItem = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  who: Schema.String,
  what: Schema.String,
  tone: WebTone
})
export type WebTimelineItem = typeof WebTimelineItem.Type

/** A judge's verdict on a lane, with the trace seq that carried it. */
export const WebVerdict = Schema.Struct({
  lane: Schema.String,
  round: Schema.Number,
  cleared: Schema.Boolean,
  issues: Schema.Number,
  dimensions: Schema.Array(
    Schema.Struct({ id: Schema.String, score: Schema.Number, max: Schema.Number })
  ),
  seq: Schema.Number
})
export type WebVerdict = typeof WebVerdict.Type

/** A task of a story's plan, in the story board's column (AgentTree `taskColumnOf`). */
export const WebTask = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  column: Schema.Literals(["todo", "doing", "done"])
})
export type WebTask = typeof WebTask.Type

export const WebStory = Schema.Struct({
  id: Schema.String,
  status: WebChipStatus,
  executor: Schema.optional(Schema.String),
  /** Who codes it, `codex#2`, once it has a lane. */
  clone: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  /** Every open stage of its lane, innermost last, for the expanded detail. */
  stages: Schema.Array(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  tokens: Schema.Number,
  prompt: Schema.Number,
  completion: Schema.Number,
  model: Schema.optional(Schema.String),
  merged: Schema.Boolean,
  failStage: Schema.optional(Schema.String),
  failMessage: Schema.optional(Schema.String),
  /** Its lane's latest tool calls, oldest first, as many as the tree keeps (20). */
  tools: Schema.Array(Schema.String),
  activity: Schema.optional(Schema.Struct({ text: Schema.String, since: Schema.Number })),
  note: Schema.optional(Schema.String),
  tasks: Schema.Array(WebTask)
})
export type WebStory = typeof WebStory.Type

export const WebExecutor = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["busy", "idle", "out"]),
  text: Schema.String,
  /** Everything it holds now, as AgentTree `heldBy` lists it. */
  leases: Schema.Array(Schema.String),
  /** Why the roster left it out of the round, when it is out. */
  reason: Schema.optional(Schema.String)
})
export type WebExecutor = typeof WebExecutor.Type

export const WebFrame = Schema.Struct({
  /** Steps folded, of `steps`; a live frame has folded them all. */
  count: Schema.Number,
  steps: Schema.Number,
  seq: Schema.optional(Schema.Number),
  lastSeq: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.Number),
  now: Schema.optional(Schema.Number),
  ended: Schema.optional(Schema.String),
  title: Schema.String,
  action: Schema.optional(Schema.String),
  stage: Schema.String,
  agents: Schema.String,
  counts: Schema.Struct({
    planned: Schema.Number,
    running: Schema.Number,
    waiting: Schema.Number,
    done: Schema.Number,
    failed: Schema.Number,
    total: Schema.Number
  }),
  tokens: Schema.Number,
  costUsd: Schema.Number,
  stories: Schema.Array(WebStory),
  /** The story the detail card follows until the reader picks one. */
  focus: Schema.optional(Schema.String),
  judge: Schema.Struct({
    executor: Schema.optional(Schema.String),
    state: Schema.Literals(["idle", "waiting", "running"]),
    reviews: Schema.Number,
    verdicts: Schema.Number,
    borrowed: Schema.Number
  }),
  verdicts: Schema.Array(WebVerdict),
  merged: Schema.Number,
  roster: Schema.Array(WebExecutor),
  /** The latest items; `timelineCount` says how many there are in all. */
  timeline: Schema.Array(WebTimelineItem),
  timelineCount: Schema.Number,
  /** The replay's wait before this frame, so the playhead moves as long. */
  gapMs: Schema.Number
})
export type WebFrame = typeof WebFrame.Type

/** A step of the trace, as the scrubber places it. */
export const WebRunStep = Schema.Struct({ seq: Schema.Number, at: Schema.Number })
export type WebRunStep = typeof WebRunStep.Type

/** The run as the page first sees it: its mode, its steps, its whole timeline for the scrubber. */
export const WebRun = Schema.Struct({
  mode: Schema.Literals(["live", "replay"]),
  runId: Schema.optional(Schema.String),
  trace: Schema.String,
  speed: Schema.Number,
  steps: Schema.Array(WebRunStep),
  lastSeq: Schema.optional(Schema.Number),
  timeline: Schema.Array(WebTimelineItem)
})
export type WebRun = typeof WebRun.Type

/** Whose transcript a tail shows: a story's, or everything an executor served. */
export const WebTailOf = Schema.Literals(["story", "executor"])
export type WebTailOf = typeof WebTailOf.Type

/** The roles a tail can keep to; none keeps every call. */
export const WebTailRole = Schema.Literals(["coder", "reviewer", "judge"])
export type WebTailRole = typeof WebTailRole.Type

/**
 * `GET /api/transcript`: the tail's lines as `watch --tail` formats them,
 * or `None` with the terminal's words when the run kept no transcript.
 */
export const WebTranscript = Schema.Union([
  Schema.TaggedStruct("Lines", {
    target: Schema.String,
    of: WebTailOf,
    role: Schema.optional(WebTailRole),
    lines: Schema.Array(Schema.String)
  }),
  Schema.TaggedStruct("None", { message: Schema.String })
])
export type WebTranscript = typeof WebTranscript.Type

/**
 * The bodies on the wire: JSON text, an absent value written as `null`. The
 * server's `schemaJson` responses and its server-sent frames use this
 * codec, and the page decodes with it.
 */
export const WebFrameJson = Schema.fromJsonString(Schema.toCodecJson(WebFrame))
export const WebRunJson = Schema.fromJsonString(Schema.toCodecJson(WebRun))
export const WebTranscriptJson = Schema.fromJsonString(Schema.toCodecJson(WebTranscript))
