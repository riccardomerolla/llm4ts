import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import { Diagnosis, StoryDetail, UnknownStory } from "@llm4ts/flow/OperatorSchemas"
import {
  loadEpicFiles,
  loadStoryFiles,
  renderStoryDigest,
  type RetroInputs
} from "@llm4ts/flow/Retro"
import { readTrace } from "@llm4ts/flow/Replay"
import { makeStoryPlanStore, type Story, type StoryPlan } from "@llm4ts/flow/StoryPlan"
import { TraceUnreadable, tailGateLogs, tailTranscript, type RunSources } from "./RunReaders.ts"
import { loadTranscript, type TranscriptFiles } from "./Transcripts.ts"

/**
 * Read-only answers about one story of an epic run, from the files the story
 * executor keeps under `<stateDir>/stories/<id>.*` and `<stateDir>/board.json`.
 */

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** A story id is a file-name stem: no separators, no dots-only, nothing that climbs. */
export const isSafeStoryId = (id: string): boolean => safeId.test(id)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const encodeJson = (value: unknown): string | undefined => JSON.stringify(value)

const planPathOf = (stateDir: string): string => join(stateDir, "plan.md")

const unknownStory = (storyId: string): UnknownStory =>
  UnknownStory.make({ message: `unknown story '${storyId}'` })

/** The plan's story, or `UnknownStory` for an unsafe id, a missing plan or an id the plan lacks. */
const storyOf = (
  sources: RunSources,
  stateDir: string,
  storyId: string
): Effect.Effect<{ readonly plan: StoryPlan; readonly story: Story }, FlowError | UnknownStory> =>
  Effect.gen(function* () {
    if (!isSafeStoryId(storyId)) {
      return yield* unknownStory(storyId)
    }
    const plan = yield* makeStoryPlanStore(sources.files).load(planPathOf(stateDir))
    const story = plan?.story(storyId)
    if (plan === undefined || story === undefined) {
      return yield* unknownStory(storyId)
    }
    return { plan, story }
  })

export const storyDetailOf = (
  sources: RunSources,
  stateDir: string,
  storyId: string
): Effect.Effect<StoryDetail, FlowError | UnknownStory> =>
  Effect.gen(function* () {
    const { story } = yield* storyOf(sources, stateDir, storyId)
    const stored = yield* loadStoryFiles(sources.files, stateDir, story)
    const epic = yield* loadEpicFiles(sources.files, stateDir)
    const item = epic.board?.items.find((candidate) => candidate.id === storyId)
    const verdictText = stored.verdict === undefined ? undefined : encodeJson(stored.verdict)
    const verdict =
      verdictText === undefined ? undefined : Option.getOrUndefined(decodeJson(verdictText))
    const gateDir = join(stateDir, "stories", storyId, "gates")
    return StoryDetail.make({
      id: story.id,
      title: story.title,
      ...(stored.state === undefined
        ? {}
        : {
            state: {
              status: stored.state.status,
              branch: stored.state.branch,
              worktree: stored.state.worktree,
              ...(stored.state.executor === undefined ? {} : { executor: stored.state.executor })
            }
          }),
      ...(item === undefined
        ? {}
        : {
            board: {
              status: item.status,
              ...(item.detail === undefined ? {} : { detail: item.detail })
            }
          }),
      tasks: (stored.plan?.tasks ?? []).map((task) => ({
        title: task.title,
        completed: task.completed
      })),
      ...(stored.findings === undefined ? {} : { findings: stored.findings }),
      ...(verdict === undefined ? {} : { verdict }),
      gateLogs: sources.listFiles(gateDir).map((name) => join(gateDir, name))
    })
  })

export const storyDiagnosisOf = (
  sources: RunSources,
  args: {
    readonly stateDir: string
    readonly storyId: string
    readonly runId: string
    readonly tracePath: string
    readonly transcriptsDir: string | undefined
    readonly budget: number
  }
): Effect.Effect<Diagnosis, FlowError | UnknownStory | TraceUnreadable> =>
  Effect.gen(function* () {
    const { plan, story } = yield* storyOf(sources, args.stateDir, args.storyId)
    const trace = yield* readTrace(sources.files, args.tracePath).pipe(
      Effect.mapError((error) =>
        TraceUnreadable.make({ path: args.tracePath, message: describeFlowError(error) })
      )
    )
    const stored = yield* loadStoryFiles(sources.files, args.stateDir, story)
    const epic = yield* loadEpicFiles(sources.files, args.stateDir)
    const transcriptFiles: TranscriptFiles = {
      read: (path) => Effect.catch(sources.files.read(path), () => Effect.succeed(undefined)),
      list: sources.listFiles
    }
    const entries =
      args.transcriptsDir === undefined
        ? undefined
        : yield* loadTranscript(transcriptFiles, args.transcriptsDir, { lane: story.id })
    const inputs: RetroInputs = {
      runId: args.runId,
      plan,
      trace,
      transcripts: entries === undefined ? undefined : new Map([[story.id, entries]]),
      report: epic.report,
      board: epic.board,
      stories: [stored]
    }
    const digest = renderStoryDigest(inputs, story.id, args.budget) ?? ""
    const item = epic.board?.items.find((candidate) => candidate.id === story.id)
    const gates = yield* tailGateLogs(
      sources,
      join(args.stateDir, "stories", story.id, "gates"),
      args.budget - digest.length
    )
    const transcriptTail = yield* tailTranscript(
      sources,
      args.transcriptsDir,
      story.id,
      gates.remaining
    )
    return Diagnosis.make({
      runId: args.runId,
      story: story.id,
      digest,
      ...(item?.detail === undefined ? {} : { failure: { message: item.detail, lane: story.id } }),
      gateLogTails: gates.tails,
      transcriptTail
    })
  })
