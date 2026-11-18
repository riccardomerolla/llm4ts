// @internal: the chat loop behind `llm4ts chat`, run only by that verb
import { join } from "node:path"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { ChiefAction, ChiefContext, failedReply, maxReplyChars } from "@llm4ts/flow/ChiefAction"
import { describeFlowError, type FlowError, type PersistenceError } from "@llm4ts/flow/FlowError"
import type { GitToolShape } from "@llm4ts/flow/GitTool"
import {
  GwsLoginRequired,
  type ChatMessage,
  type GoogleChatToolShape,
  type SpaceRef
} from "@llm4ts/flow/GoogleChatTool"
import { RunInProgress, type OperatorKnobs, type OperatorRun } from "@llm4ts/flow/OperatorSchemas"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { defaultPlanPath, parsePlan } from "@llm4ts/flow/Plan"
import { emptyTree } from "@llm4ts/runner/AgentTree"
import { plainProgressLine, summarizeTree, type PlainProgress } from "@llm4ts/runner/RunSummary"
import {
  ChatRequest,
  ChatState,
  chatDir,
  loadRequests,
  loadState,
  notePosted,
  putRequest,
  saveState
} from "./ChatState.ts"
import { validateKnobs } from "./OperatorActTools.ts"
import { discoveredRuns, transcriptsDir, type DiskRunDeps } from "./OperatorRuns.ts"
import {
  foldTrace,
  meaningfulEventsAfter,
  runDiagnosisOf,
  runStatusOf,
  type RunSources,
  type TraceFold
} from "./RunReaders.ts"
import type { RunSupervisorShape, SupervisorRepo } from "./RunSupervisor.ts"

/**
 * The chat loop (`llm4ts chat`): one beat lists the space's new messages,
 * keeps the `/bot` requests of allowed people, has the Chief decide one typed
 * action per request, acts on it and replies in the request's thread.
 */

export interface ChatOptions {
  readonly space: SpaceRef
  readonly trigger: string
  readonly marker: string
  /** User resource names (`users/…`) allowed besides the owner. */
  readonly allow: ReadonlyArray<string>
  /** The flows the Chief may start. */
  readonly flows: ReadonlyArray<string>
  readonly intervalSeconds: number
  /** Post and start nothing; tell the terminal what would happen. */
  readonly observe: boolean
}

export interface ChatLoopDeps {
  readonly chat: GoogleChatToolShape
  readonly files: PlainFileStoreShape
  readonly supervisor: RunSupervisorShape
  readonly git: GitToolShape
  readonly repo: SupervisorRepo
  readonly flows: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly path: string; readonly description: string }>
  >
  readonly sources: RunSources
  /** Absolute trace paths under one `.llm4ts/` directory. */
  readonly listTraces: (directory: string) => ReadonlyArray<string>
  /** Folder names under `.llm4ts/epics/`. */
  readonly listEpics: (directory: string) => ReadonlyArray<string>
  readonly decide: (context: ChiefContext) => Effect.Effect<ChiefAction>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly now: Effect.Effect<number>
  /** The verb's terminal. */
  readonly say: (line: string) => Effect.Effect<void>
  /** Senders already told who may ask; one reply each per process. */
  readonly strangers: Ref.Ref<ReadonlySet<string>>
  /** Why the reasoning seat may not hold the Chief (`readOnlySeatProblem`), or undefined. */
  readonly seatProblem: Effect.Effect<string | undefined>
  /** Whether the repository's git ignores `.llm4ts/`. */
  readonly ignored: Effect.Effect<boolean>
  readonly options: ChatOptions
}

// ---- Selecting requests -------------------------------------------------------------------

export type Selected =
  | { readonly _tag: "Request"; readonly message: ChatMessage; readonly body: string }
  | { readonly _tag: "Help"; readonly message: ChatMessage }
  | { readonly _tag: "Stranger"; readonly message: ChatMessage }

export const strangerReply =
  "Only the person who started me, or people they allowed, can ask me to do things here."

export const helpReply = (options: ChatOptions): string =>
  `Ask me about runs, or tell me to start one. Example: ${options.trigger} what is running? I may start: ${options.flows.join(", ")}.`

// Chat's RFC 3339 times vary in fraction digits, so spelling order is not time order.
const timeKey = (time: string): readonly [number, string] => {
  const ms = Date.parse(time)
  const fraction = /\.(\d+)/u.exec(time)?.[1] ?? ""
  return [Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms, fraction.padEnd(9, "0")]
}

const isLater = (a: string, b: string): boolean => {
  const [aMs, aFraction] = timeKey(a)
  const [bMs, bFraction] = timeKey(b)
  return aMs !== bMs ? aMs > bMs : aFraction > bFraction
}

/** The text after the trigger, or undefined when the trigger is not a whole word at the start. */
const bodyAfter = (text: string, trigger: string): string | undefined => {
  if (!text.startsWith(trigger)) return undefined
  const rest = text.slice(trigger.length)
  return rest === "" || /^\s/u.test(rest) ? rest.trim() : undefined
}

/**
 * Which messages to act on. This decides who may start coding runs: only a
 * person (`HUMAN`) who is the owner or named in `allow`, and with no owner id
 * nobody at all, `allow` included. The Chief's own messages are known by
 * name and by marker.
 */
export const selectRequests = (
  state: ChatState,
  messages: ReadonlyArray<ChatMessage>,
  options: ChatOptions
): { readonly selected: ReadonlyArray<Selected>; readonly cursor: string } => {
  let cursor = state.cursor
  const selected: Array<Selected> = []
  const posted = new Set(state.posted)
  for (const message of messages) {
    if (isLater(message.createTime, cursor)) cursor = message.createTime
    const sender = message.senderName
    if (
      posted.has(message.name) ||
      message.text.startsWith(state.marker) ||
      message.senderType !== "HUMAN" ||
      sender === undefined ||
      message.text.trim() === ""
    ) {
      continue
    }
    const body = bodyAfter(message.text, options.trigger)
    if (body === undefined) continue
    const allowed =
      state.ownerId !== undefined && (sender === state.ownerId || options.allow.includes(sender))
    if (!allowed) selected.push({ _tag: "Stranger", message })
    else if (body === "") selected.push({ _tag: "Help", message })
    else selected.push({ _tag: "Request", message, body })
  }
  return { selected, cursor }
}

// ---- Paths ---------------------------------------------------------------------------------

/** The last segment of a message name, safe as a file name. */
const messageId = (messageName: string): string => {
  const last = messageName.split("/").pop() ?? ""
  const safe = last.replace(/[^A-Za-z0-9._-]/gu, "_")
  return safe === "" || safe === "." || safe === ".." ? "_" : safe
}

const pendingPath = (dir: string, messageName: string): string =>
  join(dir, "pending", `${messageId(messageName)}.json`)

const actionPath = (dir: string, messageName: string): string =>
  join(dir, "actions", `${messageId(messageName)}.json`)

const dirOf = (deps: Pick<ChatLoopDeps, "repo" | "options">): string =>
  chatDir(deps.repo.path, deps.options.space.id)

// ---- The Chief's context -------------------------------------------------------------------

const runLimit = 20
const recentLimit = 5
const diagnosisBudget = 4_000

const emptyFold = (): TraceFold => ({ lines: [], state: emptyTree(), seq: 0 })

const foldOf = (deps: ChatLoopDeps, run: OperatorRun): Effect.Effect<TraceFold> =>
  run.tracePath === undefined
    ? Effect.succeed(emptyFold())
    : foldTrace(deps.files, run.tracePath).pipe(Effect.catch(() => Effect.succeed(emptyFold())))

interface SummarisedRun {
  readonly run: OperatorRun
  readonly state: string
  readonly summary: string
  readonly failed: boolean
}

/** The repository's runs, newest first, without the Chief's own. */
const summarisedRuns = (deps: ChatLoopDeps) =>
  Effect.gen(function* () {
    const supervised = yield* deps.supervisor.list(deps.repo.id)
    const disk: DiskRunDeps = {
      files: deps.files,
      listTraces: deps.listTraces,
      listEpics: deps.listEpics
    }
    const discovered = yield* discoveredRuns(
      disk,
      deps.repo,
      new Set(supervised.map((run) => run.runId))
    )
    const now = yield* deps.now
    const runs = [...supervised, ...discovered]
      .filter((run) => run.flow !== "chief")
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, runLimit)
    return yield* Effect.forEach(runs, (run) =>
      Effect.map(foldOf(deps, run), (fold): SummarisedRun => {
        const status = runStatusOf(fold, run, now)
        return {
          run,
          state: status.ended ?? run.state,
          summary: status.summary,
          failed:
            status.ended === "failed" ||
            (run.state === "exited" && run.exitCode !== undefined && run.exitCode !== 0)
        }
      })
    )
  })

const diagnosisOf = (deps: ChatLoopDeps, run: OperatorRun): Effect.Effect<string | undefined> => {
  const tracePath = run.tracePath
  if (tracePath === undefined) return Effect.succeed(undefined)
  const task = run.knobs.task
  return runDiagnosisOf(deps.sources, {
    runId: run.runId,
    tracePath,
    planPath: task === undefined ? undefined : join(deps.repo.path, defaultPlanPath(task)),
    transcriptsDir: transcriptsDir(deps.repo, run.runId),
    gateLogDir: undefined,
    budget: diagnosisBudget
  }).pipe(
    Effect.map((diagnosis) =>
      [
        `Run ${diagnosis.runId}`,
        ...(diagnosis.failure === undefined
          ? []
          : [
              `Failure: ${diagnosis.failure.stage === undefined ? "" : `${diagnosis.failure.stage}: `}${diagnosis.failure.message}`
            ]),
        diagnosis.digest,
        ...diagnosis.transcriptTail
      ]
        .filter((line) => line.length > 0)
        .join("\n")
    ),
    Effect.catch(() => Effect.succeed(undefined))
  )
}

const requestLine = (request: ChatRequest): string =>
  `${request.sender}: ${request.text} → ${request.status}${request.runId === undefined ? "" : ` (${request.runId})`}`

const contextFor = (deps: ChatLoopDeps, message: ChatMessage, body: string, sender: string) =>
  Effect.gen(function* () {
    const allowed = (yield* deps.flows).filter((flow) => deps.options.flows.includes(flow.name))
    const runs = yield* summarisedRuns(deps)
    const newestFailed = runs.find((entry) => entry.failed)
    const diagnosis =
      newestFailed === undefined ? undefined : yield* diagnosisOf(deps, newestFailed.run)
    const recent = (yield* loadRequests(deps.files, dirOf(deps)))
      .filter((request) => request.messageName !== message.name)
      .slice(-recentLimit)
      .map(requestLine)
    return ChiefContext.make({
      messageName: message.name,
      actionPath: actionPath(dirOf(deps), message.name),
      request: { text: body, sender },
      flows: allowed.map((flow) => ({ name: flow.name, description: flow.description })),
      runs: runs.map((entry) => ({
        runId: entry.run.runId,
        flow: entry.run.flow,
        state: entry.state,
        summary: entry.summary
      })),
      ...(diagnosis === undefined ? {} : { diagnosis }),
      recent
    })
  })

// ---- Acting --------------------------------------------------------------------------------

/** Flows that stop for a human between rounds unless told not to; nobody answers from chat. */
const pausingFlows: ReadonlySet<string> = new Set(["roundtable", "taskforce"])

interface Outcome {
  readonly status: ChatRequest["status"]
  readonly reply: string
  readonly runId?: string
}

const isActive = (run: OperatorRun): boolean => run.state === "starting" || run.state === "running"

const busyReply = (run: { readonly flow: string; readonly runId: string }): string =>
  `${run.flow} is already running (${run.runId}). Wait for it, or ask me to stop it.`

const startRun = (
  deps: ChatLoopDeps,
  state: ChatState,
  message: ChatMessage,
  action: Extract<ChiefAction, { readonly _tag: "StartRun" }>
) =>
  Effect.gen(function* () {
    const flow = (yield* deps.flows).find((candidate) => candidate.name === action.flow)
    if (flow === undefined || !deps.options.flows.includes(action.flow)) {
      return {
        status: "refused",
        reply: `I may not start ${action.flow} here. I may start: ${deps.options.flows.join(", ")}.`
      } satisfies Outcome
    }
    const knobs: OperatorKnobs = {
      task: action.task,
      requestId: message.name,
      ...(pausingFlows.has(action.flow) ? { flags: ["--no-pause"] } : {})
    }
    const valid = yield* validateKnobs(knobs).pipe(Effect.result)
    if (valid._tag === "Failure") {
      return {
        status: "refused",
        reply: `I can't start that: ${valid.failure.message}.`
      } satisfies Outcome
    }
    const runs = yield* deps.supervisor.list(deps.repo.id)
    // A replayed request: its run exists, so git and the supervisor stay untouched.
    const already = runs.find((run) => run.requestId === message.name)
    if (already !== undefined) {
      return {
        status: "started",
        reply: `${action.reply} (run ${already.runId})`,
        runId: already.runId
      } satisfies Outcome
    }
    // The checkout below would pull the tree from under a run that is working in it.
    const busy = runs.find((run) => isActive(run) && run.flow !== "chief")
    if (busy !== undefined) {
      return { status: "refused", reply: busyReply(busy), runId: busy.runId } satisfies Outcome
    }
    const dirty = yield* deps.git.uncommittedFiles
    if (dirty.length > 0) {
      return {
        status: "refused",
        reply: `I can't start ${action.flow}: the repository has ${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"}. Commit or stash them first.`
      } satisfies Outcome
    }
    yield* deps.git.checkout(state.baseBranch)
    const started = yield* deps.supervisor
      .start({
        repo: deps.repo,
        flow: { name: flow.name, path: flow.path },
        knobs: valid.success,
        baseEnvironment: deps.environment
      })
      .pipe(Effect.result)
    if (started._tag === "Failure") {
      const error = started.failure
      if (error instanceof RunInProgress) {
        const running = yield* deps.supervisor.get(error.runId)
        return {
          status: "refused",
          reply: busyReply({ flow: running?.flow ?? "A run", runId: error.runId }),
          runId: error.runId
        } satisfies Outcome
      }
      return yield* Effect.fail(error)
    }
    return {
      status: "started",
      reply: `${action.reply} (run ${started.success.runId})`,
      runId: started.success.runId
    } satisfies Outcome
  })

const act = (deps: ChatLoopDeps, state: ChatState, message: ChatMessage, action: ChiefAction) => {
  switch (action._tag) {
    case "Answer":
      return Effect.succeed<Outcome>({ status: "answered", reply: action.reply })
    case "Decline":
      return Effect.succeed<Outcome>({ status: "refused", reply: action.reply })
    case "Failed":
      return Effect.succeed<Outcome>({ status: "failed", reply: action.reply })
    case "StopRun":
      return deps.supervisor
        .stop(action.runId)
        .pipe(Effect.as<Outcome>({ status: "answered", reply: action.reply, runId: action.runId }))
    case "StartRun":
      return startRun(deps, state, message, action)
  }
}

/** What an action would do, for the terminal under `observe`. */
const wouldDo = (action: ChiefAction): ReadonlyArray<string> => {
  switch (action._tag) {
    case "StartRun":
      return [`would start ${action.flow}: ${action.task}`]
    case "StopRun":
      return [`would stop ${action.runId}`]
    default:
      return []
  }
}

// ---- One beat ------------------------------------------------------------------------------

/** Posts a reply with the marker; under `observe` tells the terminal instead and posts nothing. */
const postMarked = (
  deps: ChatLoopDeps,
  text: string,
  threadName: string | undefined
): Effect.Effect<ChatMessage | undefined, FlowError | GwsLoginRequired> =>
  deps.options.observe
    ? Effect.as(deps.say(`would reply: ${text}`), undefined)
    : deps.chat.createMessage(
        deps.options.space,
        `${deps.options.marker} ${text}`.slice(0, maxReplyChars),
        threadName
      )

const failureKind = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)
  if (Option.isNone(error)) return "defect"
  const value: unknown = error.value
  return typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string"
    ? value._tag
    : "error"
}

const isLoginRequired = (cause: Cause.Cause<unknown>): GwsLoginRequired | undefined => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof GwsLoginRequired ? error.value : undefined
}

/**
 * One pass: list what is new since the cursor, then handle each selected
 * message in order. A failure inside one request is answered and logged and
 * the beat goes on; a lapsed login and a failed list end the beat, so the
 * caller can stop or back off.
 */
export const handleBeat = (
  deps: ChatLoopDeps,
  state: ChatState
): Effect.Effect<ChatState, GwsLoginRequired | FlowError> =>
  Effect.gen(function* () {
    const { options } = deps
    const dir = dirOf(deps)
    const messages = yield* deps.chat.listMessages(options.space, state.cursor)
    const selection = selectRequests(state, messages, options)
    const current = yield* Ref.make(ChatState.make({ ...state, cursor: selection.cursor }))

    const post = (text: string, threadName: string | undefined) =>
      postMarked(deps, text, threadName).pipe(
        Effect.flatMap((posted) =>
          posted === undefined
            ? Effect.void
            : Ref.update(current, (now) => notePosted(now, posted.name))
        )
      )

    for (const selected of selection.selected) {
      const { message } = selected
      const sender = message.senderName ?? ""
      if (options.observe) {
        yield* deps.say(`${options.trigger} from ${sender} (${message.senderDisplayName ?? "?"})`)
      }
      if (selected._tag === "Help") {
        yield* post(helpReply(options), message.threadName)
        continue
      }
      if (selected._tag === "Stranger") {
        const told = yield* Ref.get(deps.strangers)
        if (told.has(sender)) continue
        yield* Ref.set(deps.strangers, new Set([...told, sender]))
        yield* post(strangerReply, message.threadName)
        continue
      }

      const received = ChatRequest.make({
        messageName: message.name,
        createTime: message.createTime,
        sender,
        text: selected.body,
        status: "received",
        ...(message.threadName === undefined ? {} : { threadName: message.threadName })
      })
      const record = (outcome: Outcome, action?: string) =>
        options.observe
          ? Effect.void
          : putRequest(
              deps.files,
              dir,
              ChatRequest.make({
                ...received,
                status: outcome.status,
                reply: outcome.reply,
                ...(action === undefined ? {} : { action }),
                ...(outcome.runId === undefined ? {} : { runId: outcome.runId })
              })
            )

      const handle = Effect.gen(function* () {
        if (!options.observe) yield* putRequest(deps.files, dir, received)
        const context = yield* contextFor(
          deps,
          message,
          selected.body,
          message.senderDisplayName ?? sender
        )
        const action = yield* deps.decide(context)
        if (options.observe) {
          for (const line of wouldDo(action)) yield* deps.say(line)
          return yield* post(action.reply, message.threadName)
        }
        const outcome = yield* act(deps, yield* Ref.get(current), message, action)
        yield* post(outcome.reply, message.threadName)
        yield* record(outcome, action._tag)
      })

      yield* handle.pipe(
        Effect.catchCause((cause) => {
          const login = isLoginRequired(cause)
          if (login !== undefined) return Effect.fail(login)
          if (Cause.hasInterrupts(cause)) return Effect.interrupt
          const failed: Outcome = { status: "failed", reply: `That failed: ${failureKind(cause)}` }
          return post(failed.reply, message.threadName).pipe(
            Effect.catch((error) =>
              error instanceof GwsLoginRequired
                ? Effect.fail(error)
                : deps.say(`could not post to ${options.space.name}: ${error._tag}`)
            ),
            Effect.andThen(record(failed))
          )
        })
      )
    }
    return yield* Ref.get(current)
  })

// ---- Deciding through the chief flow -------------------------------------------------------

const pollInterval = "500 millis"

/** How long the loop waits for one decision before it stops the chief run. */
export const decideTimeoutMs = 120_000

const ContextJson = Schema.fromJsonString(ChiefContext)
const ActionJson = Schema.fromJsonString(ChiefAction)

const failed: ChiefAction = { _tag: "Failed", reply: failedReply }

/**
 * The Chief's decision made by the bundled `chief` flow: the context goes to
 * a file, the flow runs as a read-only supervised run, and its action file is
 * read once it exits. Anything short of a clean exit within `decideTimeoutMs`
 * and a decodable action is `Failed`.
 */
export const decideThroughFlow =
  (deps: Omit<ChatLoopDeps, "decide">) =>
  (context: ChiefContext): Effect.Effect<ChiefAction> =>
    Effect.gen(function* () {
      const dir = dirOf(deps)
      const pending = pendingPath(dir, context.messageName)
      const action = actionPath(dir, context.messageName)
      const chief = (yield* deps.flows).find((flow) => flow.name === "chief")
      if (chief === undefined) return failed
      // A file left by an earlier attempt must not pass for this decision.
      yield* deps.files.remove(action)
      yield* deps.files.writeAtomic(
        pending,
        Schema.encodeSync(ContextJson)(ChiefContext.make({ ...context, actionPath: action }))
      )
      const run = yield* deps.supervisor.start({
        repo: deps.repo,
        flow: { name: chief.name, path: chief.path },
        knobs: { task: pending },
        baseEnvironment: deps.environment
      })
      const stopChief = Effect.ignore(deps.supervisor.stop(run.runId))
      const waited = yield* Effect.gen(function* () {
        let latest: OperatorRun | undefined = run
        while (latest !== undefined && isActive(latest)) {
          yield* Effect.sleep(pollInterval)
          latest = yield* deps.supervisor.get(run.runId)
        }
        return latest
      }).pipe(
        Effect.timeoutOption(decideTimeoutMs),
        Effect.onInterrupt(() => stopChief)
      )
      if (Option.isNone(waited)) {
        yield* stopChief
        return failed
      }
      const latest = waited.value
      if (latest?.state !== "exited" || latest.exitCode !== 0) return failed
      const text = yield* deps.files.read(action)
      if (text === undefined) return failed
      return yield* Schema.decodeUnknownEffect(ActionJson)(text)
    }).pipe(Effect.catch(() => Effect.succeed(failed)))

// ---- Run updates ---------------------------------------------------------------------------

/** At most one progress line per run in this window; the ending line is never held back. */
export const throttleMs = 30_000

/** Where the loop stands with one run started from chat. */
export interface Followed {
  readonly runId: string
  /** The trace seq the last story-shaped line covered. */
  readonly seq: number
  /** The plan progress the last plain line reported. */
  readonly progress: PlainProgress | undefined
  readonly lastPostedAt: number
  readonly done: boolean
}

export const startFollowing = (runId: string): Followed => ({
  runId,
  seq: 0,
  progress: undefined,
  lastPostedAt: Number.NEGATIVE_INFINITY,
  done: false
})

const outcomeOf = (run: OperatorRun | undefined): string => {
  if (run === undefined) return "lost"
  if (run.state === "exited") return run.exitCode === 0 ? "completed" : "failed"
  return run.state
}

const planProgressOf = (deps: ChatLoopDeps, run: OperatorRun | undefined) =>
  Effect.gen(function* () {
    const task = run?.knobs.task
    if (task === undefined) return undefined
    const markdown = yield* deps.files.read(join(deps.repo.path, defaultPlanPath(task)))
    if (markdown === undefined) return undefined
    const plan = yield* parsePlan(markdown)
    return {
      tasksTotal: plan.tasks.length,
      tasksDone: plan.tasks.filter((entry) => entry.completed).length
    } satisfies PlainProgress
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/**
 * One look at a run started from chat: post what changed into the thread of
 * the request that started it, at most once per `throttleMs`, and its end
 * always, once. A failed post is told to the terminal and tried again next
 * time; only a lapsed login fails.
 */
export const followRun = (
  deps: ChatLoopDeps,
  state: ChatState,
  followed: Followed
): Effect.Effect<
  { readonly followed: Followed; readonly state: ChatState },
  GwsLoginRequired | PersistenceError
> =>
  Effect.gen(function* () {
    const unchanged = { followed, state }
    if (followed.done) return unchanged
    const dir = dirOf(deps)
    const request = (yield* loadRequests(deps.files, dir)).find(
      (entry) =>
        entry.runId === followed.runId && (entry.status === "started" || entry.status === "ended")
    )
    if (request === undefined || request.status === "ended") {
      return { followed: { ...followed, done: true }, state }
    }
    const run = yield* deps.supervisor.get(followed.runId)
    const fold = run === undefined ? emptyFold() : yield* foldOf(deps, run)
    const now = yield* deps.now
    const ended = run === undefined || !isActive(run)

    const post = (text: string) =>
      postMarked(deps, text, request.threadName).pipe(
        Effect.map((posted) => (posted === undefined ? state : notePosted(state, posted.name))),
        Effect.catch((error) =>
          error instanceof GwsLoginRequired
            ? Effect.fail(error)
            : Effect.as(
                deps.say(`could not post to ${deps.options.space.name}: ${error._tag}`),
                undefined
              )
        )
      )

    const progress = yield* planProgressOf(deps, run)
    if (ended) {
      const outcome = fold.state.ended ?? outcomeOf(run)
      const startedAt = fold.state.startedAt ?? run?.startedAt ?? now
      const endedAt = fold.state.ended === undefined ? now : (fold.state.now ?? now)
      const branch = yield* deps.git.currentBranch.pipe(Effect.option)
      const commits = yield* deps.git.commitsAhead(state.baseBranch).pipe(Effect.option)
      const line = plainProgressLine(followed.runId, followed.progress, {
        tasksTotal: progress?.tasksTotal ?? 0,
        tasksDone: progress?.tasksDone ?? 0,
        ended: {
          outcome,
          minutes: Math.max(0, Math.floor((endedAt - startedAt) / 60_000)),
          costUsd: fold.state.costUsd,
          ...(Option.isSome(branch) ? { branch: branch.value } : {}),
          ...(Option.isSome(commits) ? { commits: commits.value } : {})
        }
      })
      const posted = line === undefined ? state : yield* post(line)
      if (posted === undefined) return unchanged
      yield* putRequest(deps.files, dir, ChatRequest.make({ ...request, status: "ended", outcome }))
      return { followed: { ...followed, seq: fold.seq, done: true }, state: posted }
    }

    if (now - followed.lastPostedAt < throttleMs) return unchanged
    if (fold.state.stories.length > 0) {
      if (meaningfulEventsAfter(fold.lines, followed.seq).length === 0) return unchanged
      const posted = yield* post(`${followed.runId}: ${summarizeTree(fold.state, run?.flow)}`)
      if (posted === undefined) return unchanged
      return { followed: { ...followed, seq: fold.seq, lastPostedAt: now }, state: posted }
    }
    const line =
      progress === undefined
        ? undefined
        : plainProgressLine(followed.runId, followed.progress, progress)
    if (line === undefined) return unchanged
    const posted = yield* post(line)
    if (posted === undefined) return unchanged
    return { followed: { ...followed, progress, lastPostedAt: now }, state: posted }
  })

// ---- Starting and the loop -----------------------------------------------------------------

export class ChatStopped extends Schema.TaggedError<ChatStopped>()("ChatStopped", {
  message: Schema.String
}) {}

const stopped = (message: string): ChatStopped => ChatStopped.make({ message })

const loginExpired = stopped("Google login expired. Run: gws auth login")

const ignoreWarning =
  "Warning: .llm4ts/ is not ignored by git in this repository; add it to .gitignore."

/** A Chat failure at start as a sentence; a lapsed login is always the same one. */
const stoppedBy =
  (doing: string) =>
  (error: FlowError | GwsLoginRequired): ChatStopped =>
    error instanceof GwsLoginRequired
      ? loginExpired
      : stopped(`${doing}: ${describeFlowError(error)}`)

/**
 * The start checks, then the state: `gws` answers its probe, the space can be
 * listed, and the reasoning seat enforces read-only. A new state starts its
 * cursor now, so old `/bot` messages are not replayed. Unless `observe`, the
 * Chief says it is listening, and whoever that line is posted as is the owner.
 */
export const startChat = (
  deps: ChatLoopDeps
): Effect.Effect<ChatState, ChatStopped | PersistenceError> =>
  Effect.gen(function* () {
    const { options } = deps
    yield* deps.chat.probe.pipe(Effect.mapError(stoppedBy("gws is not ready")))
    const now = new Date(yield* deps.now).toISOString()
    yield* deps.chat
      .listMessages(options.space, now)
      .pipe(Effect.mapError(stoppedBy(`Cannot list messages in ${options.space.name}`)))
    const problem = yield* deps.seatProblem
    if (problem !== undefined) return yield* stopped(`The Chief cannot use its seat: ${problem}.`)

    const dir = dirOf(deps)
    const loaded = yield* loadState(deps.files, dir)
    const baseBranch =
      loaded?.baseBranch ??
      (yield* deps.git.currentBranch.pipe(
        Effect.mapError((error) =>
          stopped(`Cannot read the current branch: ${describeFlowError(error)}`)
        )
      ))
    let state = ChatState.make({
      space: options.space.name,
      cursor: now,
      posted: [],
      ...loaded,
      trigger: options.trigger,
      marker: options.marker,
      baseBranch
    })
    if (!(yield* deps.ignored)) yield* deps.say(ignoreWarning)
    if (!options.observe) {
      const listening = yield* deps.chat
        .createMessage(
          options.space,
          `${options.marker} Listening. Repository ${deps.repo.id}. I may start: ${options.flows.join(", ")}.`
        )
        .pipe(Effect.mapError(stoppedBy(`Cannot post to ${options.space.name}`)))
      if (listening.senderName === undefined) {
        return yield* stopped(
          "Chat did not say who posted the listening line, so nobody could ask."
        )
      }
      state = ChatState.make({
        ...notePosted(state, listening.name),
        ownerId: listening.senderName
      })
    }
    yield* saveState(deps.files, dir, state)
    return state
  })

const backoffStartMs = 1_000
const backoffCapMs = 60_000

/**
 * `startChat`, then forever: one beat, a look at every run started from chat,
 * the state saved, a sleep. A failed list backs off and never ends the loop;
 * a lapsed login does.
 */
export const runChat = (deps: ChatLoopDeps): Effect.Effect<never, ChatStopped | PersistenceError> =>
  Effect.gen(function* () {
    const { options } = deps
    const dir = dirOf(deps)
    let state = yield* startChat(deps)
    // In memory only: after a restart a run's last line may be posted once more.
    const follows = new Map<string, Followed>()
    let failures = 0
    while (true) {
      const beat = yield* Effect.result(handleBeat(deps, state))
      if (beat._tag === "Failure") {
        if (beat.failure instanceof GwsLoginRequired) return yield* loginExpired
        failures += 1
        const wait = Math.min(backoffStartMs * 2 ** (failures - 1), backoffCapMs)
        yield* deps.say(
          `could not list messages in ${options.space.name}: ${beat.failure._tag}; retrying in ${wait / 1_000} s`
        )
        yield* Effect.sleep(Duration.millis(wait))
        continue
      }
      failures = 0
      state = beat.success
      for (const request of yield* loadRequests(deps.files, dir)) {
        if (request.status !== "started" || request.runId === undefined) continue
        const step = yield* followRun(
          deps,
          state,
          follows.get(request.runId) ?? startFollowing(request.runId)
        ).pipe(
          Effect.mapError((error) => (error instanceof GwsLoginRequired ? loginExpired : error))
        )
        state = step.state
        if (step.followed.done) follows.delete(request.runId)
        else follows.set(request.runId, step.followed)
      }
      yield* saveState(deps.files, dir, state)
      yield* Effect.sleep(Duration.seconds(options.intervalSeconds))
    }
  })
