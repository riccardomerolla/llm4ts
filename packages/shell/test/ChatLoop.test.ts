import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { ChiefAction, ChiefContext, failedReply } from "@llm4ts/flow/ChiefAction"
import { PersistenceError, ProcessError } from "@llm4ts/flow/FlowError"
import { Info, StoryStatusChanged, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { ChatMessage, GwsLoginRequired, SpaceRef } from "@llm4ts/flow/GoogleChatTool"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { defaultPlanPath } from "@llm4ts/flow/Plan"
import { summarizeTree } from "@llm4ts/runner/RunSummary"
import {
  ChatStopped,
  decideThroughFlow,
  decideTimeoutMs,
  followRun,
  handleBeat,
  helpReply,
  runChat,
  selectRequests,
  startChat,
  startFollowing,
  strangerReply,
  throttleMs,
  type ChatLoopDeps,
  type ChatOptions
} from "@llm4ts/shell/ChatLoop"
import {
  ChatRequest,
  ChatState,
  chatDir,
  loadRequests,
  loadState,
  putRequest,
  saveState
} from "@llm4ts/shell/ChatState"
import { makeFakeFlowProcess } from "@llm4ts/shell/FlowProcess"
import { foldTrace } from "@llm4ts/shell/RunReaders"
import { makeRunSupervisor, type SupervisorRepo } from "@llm4ts/shell/RunSupervisor"
import { makeFakeChat, ownerId } from "./support/FakeChat.ts"
import { fakeGit } from "./support/FakeGit.ts"

const repo: SupervisorRepo = { id: "app", path: "/work/app" }
const space = new SpaceRef({ id: "AAA" })
const marker = "🌙 chief:"
const dir = chatDir(repo.path, space.id)

const options: ChatOptions = {
  space,
  trigger: "/bot",
  marker,
  allow: [],
  flows: ["implement", "taskforce"],
  intervalSeconds: 5,
  observe: false
}

const initial = ChatState.make({
  space: space.name,
  trigger: "/bot",
  marker,
  cursor: "",
  posted: [],
  ownerId,
  baseBranch: "main"
})

const flows = [
  { name: "implement", path: "/flows/implement.ts", description: "Plan, code and review a task" },
  { name: "taskforce", path: "/flows/taskforce.ts", description: "A delegation loop" },
  { name: "epic-stories", path: "/flows/epic-stories.ts", description: "Stories of an epic" },
  { name: "chief", path: "/flows/chief.ts", description: "One chat decision" }
]

type Scripted = ChiefAction | "defect"

const setup = (script: ReadonlyArray<Scripted> = [], overrides: Partial<ChatOptions> = {}) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const fake = yield* makeFakeFlowProcess()
    const chat = yield* makeFakeChat()
    let suffix = 0xbeef
    const supervisor = yield* makeRunSupervisor({
      repos: [repo],
      environment: { HOME: "/home/op", XDG_STATE_HOME: "/state" },
      files: memory.store,
      process: fake.process,
      parallelRuns: 1,
      random: () => (suffix++).toString(16)
    })
    const gitLog = yield* Ref.make<ReadonlyArray<string>>([])
    const dirty = yield* Ref.make<ReadonlyArray<string>>([])
    const lines = yield* Ref.make<ReadonlyArray<string>>([])
    const contexts = yield* Ref.make<ReadonlyArray<ChiefContext>>([])
    const remaining = yield* Ref.make<ReadonlyArray<Scripted>>(script)
    const strangers = yield* Ref.make<ReadonlySet<string>>(new Set())
    const decide = (context: ChiefContext) =>
      Effect.gen(function* () {
        yield* Ref.update(contexts, (all) => [...all, context])
        const [next, ...rest] = yield* Ref.get(remaining)
        yield* Ref.set(remaining, rest)
        if (next === undefined || next === "defect") return yield* Effect.die("the seat broke")
        return next
      })
    const deps: ChatLoopDeps = {
      chat: chat.tool,
      files: memory.store,
      supervisor,
      git: fakeGit(gitLog, dirty),
      repo,
      flows: Effect.succeed(flows),
      sources: { files: memory.store, listFiles: () => [] },
      listTraces: () => [],
      listEpics: () => [],
      decide,
      environment: { PATH: "/usr/bin", HOME: "/home/op" },
      now: Clock.currentTimeMillis,
      say: (line) => Ref.update(lines, (all) => [...all, line]),
      strangers,
      seatProblem: Effect.succeed(undefined),
      ignored: Effect.succeed(true),
      options: { ...options, ...overrides }
    }
    return { deps, memory, fake, chat, gitLog, dirty, lines, contexts }
  })

/** The store, with reads or writes of the paths `failing` names refused while `on` holds. */
const failingFiles = (
  store: PlainFileStoreShape,
  failing: { readonly reads?: string; readonly writes?: string },
  on: Ref.Ref<boolean> | undefined = undefined
): PlainFileStoreShape => {
  const refused = (path: string, suffix: string | undefined) =>
    Effect.gen(function* () {
      if (suffix === undefined || !path.endsWith(suffix)) return false
      return on === undefined ? true : yield* Ref.get(on)
    })
  const disk = PersistenceError.make({ message: "disk full" })
  return {
    ...store,
    read: (path) =>
      Effect.flatMap(refused(path, failing.reads), (no) =>
        no ? Effect.fail(disk) : store.read(path)
      ),
    writeAtomic: (path, text) =>
      Effect.flatMap(refused(path, failing.writes), (no) =>
        no ? Effect.fail(disk) : store.writeAtomic(path, text)
      )
  }
}

/** Lets forked fibers run until `check` holds; fails the test after many turns. */
const until = <A>(read: Effect.Effect<A>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1_000; turn++) {
      if (check(yield* read)) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die("the condition never held")
  })

const texts = (posted: ReadonlyArray<{ readonly text: string }>) => posted.map((p) => p.text)

const message = (text: string, fields: Partial<ChatMessage> = {}): ChatMessage =>
  new ChatMessage({
    name: "spaces/AAA/messages/x",
    createTime: "2026-11-18T10:00:01.000Z",
    text,
    senderName: ownerId,
    senderType: "HUMAN",
    ...fields
  })

describe("selectRequests", () => {
  it("ignores its own messages by name, and by marker once the names are gone", () => {
    // A marker that begins with the trigger: only the marker filter can drop these.
    const triggerMarker = ChatState.make({ ...initial, marker: "/bot says:" })
    const byName = message("/bot says: hello", { name: "spaces/AAA/messages/mine" })
    const byMarker = message("/bot says: hello", { name: "spaces/AAA/messages/other" })
    const kept = selectRequests(
      ChatState.make({ ...triggerMarker, posted: [byName.name] }),
      [byName, byMarker],
      options
    )
    assert.deepStrictEqual(kept.selected, [])
    const emptied = selectRequests(triggerMarker, [byMarker], options)
    assert.deepStrictEqual(emptied.selected, [])
    // Without the marker filter the same message is a request.
    assert.deepStrictEqual(
      selectRequests(initial, [byMarker], options).selected.map((s) => s._tag),
      ["Request"]
    )
  })

  it("reads /bot alone as Help and ignores /bots", () => {
    const help = message("/bot")
    const result = selectRequests(initial, [help, message("/bots are great")], options)
    assert.deepStrictEqual(
      result.selected.map((s) => s._tag),
      ["Help"]
    )
  })

  it("keeps the body after the trigger", () => {
    const result = selectRequests(initial, [message("/bot  what is running? ")], options)
    const [first] = result.selected
    assert.strictEqual(first?._tag, "Request")
    if (first?._tag === "Request") assert.strictEqual(first.body, "what is running?")
  })

  it("allows the owner and --allow'ed senders; nobody without an owner id", () => {
    const stranger = message("/bot hi", { senderName: "users/stranger" })
    const friend = message("/bot hi", { senderName: "users/friend" })
    const tags = (state: ChatState, allow: ReadonlyArray<string>) =>
      selectRequests(state, [message("/bot hi"), stranger, friend], {
        ...options,
        allow
      }).selected.map((s) => s._tag)
    assert.deepStrictEqual(tags(initial, ["users/friend"]), ["Request", "Stranger", "Request"])
    const ownerless = ChatState.make({ ...initial, ownerId: undefined })
    assert.deepStrictEqual(tags(ownerless, []), ["Stranger", "Stranger", "Stranger"])
    assert.deepStrictEqual(tags(ownerless, ["users/friend"]), ["Stranger", "Stranger", "Stranger"])
  })

  it("ignores app, senderless and empty messages and moves the cursor past them", () => {
    const app = message("/bot hi", { senderType: "BOT", createTime: "2026-11-18T10:00:01.000Z" })
    const senderless = message("/bot hi", {
      senderName: undefined,
      createTime: "2026-11-18T10:00:02.000Z"
    })
    const empty = message("", { createTime: "2026-11-18T10:00:03.500Z" })
    const result = selectRequests(initial, [app, senderless, empty], options)
    assert.deepStrictEqual(result.selected, [])
    assert.strictEqual(result.cursor, "2026-11-18T10:00:03.500Z")
    assert.strictEqual(selectRequests(initial, [], options).cursor, "")
  })

  it("orders times by instant, not by spelling", () => {
    const whole = message("hi", { createTime: "2026-11-18T10:00:03Z" })
    const fraction = message("hi", { createTime: "2026-11-18T10:00:03.250Z" })
    assert.strictEqual(
      selectRequests(initial, [fraction, whole], options).cursor,
      "2026-11-18T10:00:03.250Z"
    )
  })
})

describe("helpReply", () => {
  it("names the trigger and the flows", () => {
    assert.strictEqual(
      helpReply(options),
      "Ask me about runs, or tell me to start one. Example: /bot what is running? I may start: implement, taskforce."
    )
  })
})

const answer = (reply: string): ChiefAction => ({ _tag: "Answer", reply })
const startRun = (flow: string, task: string): ChiefAction => ({
  _tag: "StartRun",
  flow,
  task,
  reply: `Starting ${flow}.`
})

describe("handleBeat", () => {
  it.effect("answers /bot alone with help and does not decide", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, contexts } = yield* setup()
        const asked = yield* chat.add("/bot")
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(yield* chat.posted, [
          { text: `${marker} ${helpReply(options)}`, threadName: asked.threadName }
        ])
        assert.deepStrictEqual(yield* Ref.get(contexts), [])
      })
    )
  )

  it.effect("tells a stranger once who may ask, and never decides for them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, contexts } = yield* setup()
        const from = { senderName: "users/stranger", senderDisplayName: "Eve" }
        yield* chat.add("/bot start something", from)
        yield* chat.add("/bot please", from)
        const state = yield* handleBeat(deps, initial)
        yield* chat.add("/bot pretty please", from)
        yield* handleBeat(deps, state)
        assert.deepStrictEqual(texts(yield* chat.posted), [`${marker} ${strangerReply}`])
        assert.deepStrictEqual(yield* Ref.get(contexts), [])
      })
    )
  )

  it.effect("handles a sender named with --allow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup([answer("Nothing runs.")], {
          allow: ["users/friend"]
        })
        yield* chat.add("/bot what runs?", { senderName: "users/friend" })
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(texts(yield* chat.posted), [`${marker} Nothing runs.`])
      })
    )
  )

  it.effect("posts an Answer in the request's thread and records it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, memory, contexts } = yield* setup([answer("Nothing runs.")])
        const asked = yield* chat.add("/bot what runs?")
        const state = yield* handleBeat(deps, initial)
        const posted = yield* chat.posted
        assert.deepStrictEqual(posted, [
          { text: `${marker} Nothing runs.`, threadName: asked.threadName }
        ])
        assert.strictEqual(state.posted.length, 1)
        assert.strictEqual(state.cursor, asked.createTime)
        const [context] = yield* Ref.get(contexts)
        assert.deepStrictEqual(
          context?.flows.map((f) => f.name),
          ["implement", "taskforce"]
        )
        assert.strictEqual(context?.request.text, "what runs?")
        assert.strictEqual(context?.actionPath, `${dir}/actions/m1.json`)
        const [request] = yield* loadRequests(memory.store, dir)
        assert.strictEqual(request?.status, "answered")
        assert.strictEqual(request?.reply, "Nothing runs.")
      })
    )
  )

  it.effect("starts one run with the message name as requestId; a second gets the running id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, memory } = yield* setup([
          startRun("implement", "add a health check"),
          startRun("implement", "add a readme")
        ])
        const first = yield* chat.add("/bot add a health check")
        yield* chat.add("/bot add a readme")
        yield* handleBeat(deps, initial)
        const started = yield* fake.started
        assert.strictEqual(started.length, 1)
        assert.deepStrictEqual(started[0]?.args, ["add a health check"])
        const [run] = yield* deps.supervisor.list(repo.id)
        assert.strictEqual(run?.requestId, first.name)
        const posted = texts(yield* chat.posted)
        assert.include(posted[0] ?? "", run?.runId ?? "?")
        assert.include(posted[1] ?? "", `already running (${run?.runId ?? "?"})`)
        const requests = yield* loadRequests(memory.store, dir)
        assert.deepStrictEqual(
          requests.map((r) => [r.status, r.runId]),
          [
            ["started", run?.runId],
            ["refused", run?.runId]
          ]
        )
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  for (const task of ["-rf", "@x"]) {
    it.effect(`refuses a task of ${task} in words and starts nothing`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { deps, chat, fake } = yield* setup([startRun("implement", task)])
          yield* chat.add("/bot do it")
          yield* handleBeat(deps, initial)
          assert.deepStrictEqual(yield* fake.started, [])
          assert.deepStrictEqual(texts(yield* chat.posted), [
            `${marker} I can't start that: task must not start with '-' or '@'.`
          ])
        })
      )
    )
  }

  it.effect("refuses on a dirty tree and starts nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, dirty, gitLog } = yield* setup([startRun("implement", "fix")])
        yield* Ref.set(dirty, ["src/a.ts", "src/b.ts"])
        yield* chat.add("/bot fix")
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(yield* fake.started, [])
        assert.deepStrictEqual(yield* Ref.get(gitLog), [])
        assert.deepStrictEqual(texts(yield* chat.posted), [
          `${marker} I can't start implement: the repository has 2 uncommitted files. Commit or stash them first.`
        ])
      })
    )
  )

  it.effect("checks out the base branch before starting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, gitLog } = yield* setup([startRun("implement", "fix")])
        yield* chat.add("/bot fix")
        yield* handleBeat(deps, ChatState.make({ ...initial, baseBranch: "develop" }))
        assert.deepStrictEqual(yield* Ref.get(gitLog), ["checkout:develop"])
        const [started] = yield* fake.started
        assert.isDefined(started)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("passes --no-pause to taskforce only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake } = yield* setup([
          startRun("implement", "one"),
          startRun("taskforce", "two")
        ])
        yield* chat.add("/bot one")
        yield* handleBeat(deps, initial).pipe(
          Effect.flatMap((state) =>
            Effect.gen(function* () {
              const [run] = yield* deps.supervisor.list(repo.id)
              yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
              yield* until(deps.supervisor.list(repo.id), (runs) =>
                runs.every((r) => r.state === "exited")
              )
              yield* chat.add("/bot two")
              return yield* handleBeat(deps, state)
            })
          )
        )
        const started = yield* fake.started
        assert.deepStrictEqual(
          started.map((s) => s.args),
          [["one"], ["two", "--no-pause"]]
        )
        const runs = yield* deps.supervisor.list(repo.id)
        for (const run of runs) yield* fake.exit(run.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("refuses a flow outside the allowed list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake } = yield* setup([startRun("epic-stories", "go")])
        yield* chat.add("/bot go")
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(yield* fake.started, [])
        assert.deepStrictEqual(texts(yield* chat.posted), [
          `${marker} I may not start epic-stories here. I may start: implement, taskforce.`
        ])
      })
    )
  )

  it.effect("stops a run on StopRun", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // TestClock starts at 0 and the suffix counts from beef, so the run id is known up front.
        const runId = "op-0-beef"
        const { deps, chat, fake } = yield* setup([
          startRun("implement", "fix"),
          { _tag: "StopRun", runId, reply: "Stopping it." }
        ])
        yield* chat.add("/bot fix")
        const state = yield* handleBeat(deps, initial)
        yield* chat.add("/bot stop")
        const fiber = yield* handleBeat(deps, state).pipe(Effect.forkChild)
        yield* until(fake.signals, (signals) => signals.length > 0)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: undefined, signal: "SIGINT" })
        yield* Fiber.join(fiber)
        assert.deepStrictEqual(texts(yield* chat.posted).slice(1), [`${marker} Stopped ${runId}.`])
        assert.strictEqual((yield* deps.supervisor.get(runId))?.state, "interrupted")
      })
    )
  )

  it.effect("says a run that already ended was not running, whatever the Chief wrote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runId = "op-0-beef"
        const { deps, chat, fake } = yield* setup([
          startRun("implement", "fix"),
          { _tag: "StopRun", runId, reply: "Stopped it." }
        ])
        yield* chat.add("/bot fix")
        const state = yield* handleBeat(deps, initial)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
        yield* until(deps.supervisor.get(runId), (latest) => latest?.state === "exited")
        yield* chat.add("/bot stop")
        yield* handleBeat(deps, state)
        assert.deepStrictEqual(texts(yield* chat.posted).slice(1), [
          `${marker} ${runId} was not running.`
        ])
      })
    )
  )

  it.effect("posts the failure line on a decide defect and handles the next request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, memory } = yield* setup(["defect", answer("Still here.")])
        yield* chat.add("/bot one")
        yield* chat.add("/bot two")
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(texts(yield* chat.posted), [
          `${marker} That failed: defect`,
          `${marker} Still here.`
        ])
        const requests = yield* loadRequests(memory.store, dir)
        assert.deepStrictEqual(
          requests.map((r) => r.status),
          ["failed", "answered"]
        )
      })
    )
  )

  it.effect("tells the terminal when a request cannot be recorded, and moves on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup([answer("Hi."), answer("Again.")])
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          files: failingFiles(fixture.memory.store, { writes: "requests.md" })
        }
        const asked = yield* fixture.chat.add("/bot hi")
        const state = yield* handleBeat(deps, initial)
        assert.strictEqual(state.cursor, asked.createTime)
        // The next beat sees nothing new: no second decision, no second reply.
        yield* handleBeat(deps, state)
        assert.deepStrictEqual(texts(yield* fixture.chat.posted), [`${marker} Hi.`])
        assert.strictEqual((yield* Ref.get(fixture.contexts)).length, 1)
        assert.deepStrictEqual(yield* Ref.get(fixture.lines), [
          `could not record ${asked.name}: disk full`,
          `could not record ${asked.name}: disk full`
        ])
      })
    )
  )

  it.effect("records a started run before its reply, so a failed post still follows it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup([startRun("implement", task)])
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          chat: {
            ...fixture.deps.chat,
            createMessage: () => Effect.fail(ProcessError.make({ message: "gws", detail: "boom" }))
          }
        }
        const asked = yield* fixture.chat.add(`/bot ${task}`)
        const state = yield* handleBeat(deps, initial)
        const [run] = yield* deps.supervisor.list(repo.id)
        const requests = yield* loadRequests(fixture.memory.store, dir)
        assert.deepStrictEqual(
          requests.map((r) => [r.status, r.runId]),
          [["started", run?.runId]]
        )
        assert.deepStrictEqual(yield* Ref.get(fixture.lines), [
          `could not post to ${space.name}: Process`
        ])
        // Chat is back: the run is followed into the request's thread.
        yield* fixture.memory.store.writeAtomic(planPath, planOf(0))
        yield* followRun(fixture.deps, state, startFollowing(run?.runId ?? ""))
        assert.deepStrictEqual(yield* fixture.chat.posted, [
          {
            text: `${marker} ${run?.runId ?? "?"}: plan written, 4 tasks`,
            threadName: asked.threadName
          }
        ])
        yield* fixture.fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("does not replay handled messages after a restart from saved state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, memory, contexts } = yield* setup([answer("Once.")])
        yield* chat.add("/bot hi")
        yield* saveState(memory.store, dir, yield* handleBeat(deps, initial))
        const restored = yield* loadState(memory.store, dir)
        assert.isDefined(restored)
        if (restored !== undefined) yield* handleBeat(deps, restored)
        assert.strictEqual((yield* Ref.get(contexts)).length, 1)
        assert.deepStrictEqual(texts(yield* chat.posted), [`${marker} Once.`])
      })
    )
  )

  it.effect("under observe posts and starts nothing and tells the terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, lines } = yield* setup([startRun("implement", "fix")], {
          observe: true,
          allow: ["users/friend"]
        })
        yield* chat.add("/bot fix", { senderName: "users/friend", senderDisplayName: "Ada" })
        yield* chat.add("/bot hi", { senderName: "users/eve", senderDisplayName: "Eve" })
        yield* handleBeat(deps, initial)
        assert.deepStrictEqual(yield* chat.posted, [])
        assert.deepStrictEqual(yield* fake.started, [])
        assert.deepStrictEqual(yield* Ref.get(lines), [
          "/bot from users/friend (Ada)",
          "would start implement: fix",
          "would reply: Starting implement.",
          "/bot from users/eve (Eve)",
          `would reply: ${strangerReply}`
        ])
      })
    )
  )

  it.effect("with no owner id an --allow'ed sender is a stranger: printed, never decided", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, lines, contexts } = yield* setup([startRun("implement", "fix")], {
          observe: true,
          allow: ["users/friend"]
        })
        yield* chat.add("/bot fix", { senderName: "users/friend", senderDisplayName: "Ada" })
        yield* handleBeat(deps, ChatState.make({ ...initial, ownerId: undefined }))
        assert.deepStrictEqual(yield* chat.posted, [])
        assert.deepStrictEqual(yield* fake.started, [])
        assert.deepStrictEqual(yield* Ref.get(contexts), [])
        assert.deepStrictEqual(yield* Ref.get(lines), [
          "/bot from users/friend (Ada)",
          `would reply: ${strangerReply}`
        ])
      })
    )
  )

  it.effect(
    "a replayed StartRun names its live run and touches neither git nor the supervisor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { deps, chat, fake, gitLog, memory } = yield* setup([
            startRun("implement", "fix"),
            startRun("implement", "fix")
          ])
          yield* chat.add("/bot fix")
          yield* handleBeat(deps, initial)
          // The same message again, as after a restart that lost the cursor.
          yield* handleBeat(deps, initial)
          assert.strictEqual((yield* fake.started).length, 1)
          assert.deepStrictEqual(yield* Ref.get(gitLog), ["checkout:main"])
          const [run] = yield* deps.supervisor.list(repo.id)
          assert.strictEqual(run?.state, "running")
          const posted = texts(yield* chat.posted)
          assert.strictEqual(posted.length, 2)
          assert.include(posted[1] ?? "", `(run ${run?.runId ?? "?"})`)
          const requests = yield* loadRequests(memory.store, dir)
          assert.deepStrictEqual(
            requests.map((r) => [r.status, r.runId]),
            [["started", run?.runId]]
          )
          yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
        })
      )
  )

  it.effect("fails on GwsLoginRequired from listMessages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup()
        yield* chat.failWith(GwsLoginRequired.make({ message: "login" }))
        const error = yield* Effect.flip(handleBeat(deps, initial))
        assert.strictEqual(error._tag, "GwsLoginRequired")
      })
    )
  )

  it.effect("fails with the list's FlowError so the loop can back off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup()
        yield* chat.failWith(ProcessError.make({ message: "gws", detail: "boom" }))
        const error = yield* Effect.flip(handleBeat(deps, initial))
        assert.strictEqual(error._tag, "Process")
      })
    )
  )
})

const ActionJson = Schema.fromJsonString(ChiefAction)

const contextFor = (messageName: string): ChiefContext =>
  ChiefContext.make({
    messageName,
    actionPath: "",
    request: { text: "what runs?", sender: "Owner" },
    flows: [],
    runs: [],
    recent: []
  })

describe("decideThroughFlow", () => {
  it.effect("starts chief on the context file and returns the action it wrote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake, memory } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/a.b~c")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        const [started] = yield* fake.started
        assert.strictEqual(started?.flowPath, "/flows/chief.ts")
        assert.deepStrictEqual(started?.args, [`${dir}/pending/a.b_c.json`])
        const written = (yield* memory.files)[`${dir}/pending/a.b_c.json`] ?? ""
        assert.include(written, `"actionPath":"${dir}/actions/a.b_c.json"`)
        yield* memory.store.writeAtomic(
          `${dir}/actions/a.b_c.json`,
          Schema.encodeSync(ActionJson)(answer("Nothing runs."))
        )
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Fiber.join(fiber), answer("Nothing runs."))
      })
    )
  )

  it.effect("is Failed when chief exits without an action file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake, lines } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/q")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reply: failedReply })
        assert.deepStrictEqual(yield* Ref.get(lines), [
          `The Chief could not decide on spaces/AAA/messages/q: chief run ${run?.runId ?? "?"} wrote no action; its logs are in ${run?.logDir ?? "?"}`
        ])
      })
    )
  )

  it.effect("is Failed, and says so, when no chief flow is found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps = { ...fixture.deps, flows: Effect.succeed(flows.slice(0, 1)) }
        const action = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/u"))
        assert.deepStrictEqual(action, { _tag: "Failed", reply: failedReply })
        assert.deepStrictEqual(yield* fixture.fake.started, [])
        assert.deepStrictEqual(yield* Ref.get(fixture.lines), [
          "The Chief could not decide on spaces/AAA/messages/u: no chief flow was found"
        ])
      })
    )
  )

  it.effect("is Failed on a non-zero exit even with an action file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake, memory, lines } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/r")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        yield* memory.store.writeAtomic(
          `${dir}/actions/r.json`,
          Schema.encodeSync(ActionJson)(answer("Nothing runs."))
        )
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 1, signal: undefined })
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reply: failedReply })
        assert.deepStrictEqual(yield* Ref.get(lines), [
          `The Chief could not decide on spaces/AAA/messages/r: chief run ${run?.runId ?? "?"} ended exited, exit code 1; its logs are in ${run?.logDir ?? "?"}`
        ])
      })
    )
  )
})

describe("decideThroughFlow bound", () => {
  it.effect("stops chief and is Failed after the bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake, lines } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/s")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        yield* TestClock.adjust(decideTimeoutMs - 1_000)
        assert.deepStrictEqual(yield* fake.signals, [])
        yield* TestClock.adjust("1 second")
        yield* until(fake.signals, (signals) => signals.length > 0)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: undefined, signal: "SIGINT" })
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reply: failedReply })
        assert.deepStrictEqual(yield* Ref.get(lines), [
          `The Chief could not decide on spaces/AAA/messages/s: chief run ${run?.runId ?? "?"} gave no decision within 120 s; its logs are in ${run?.logDir ?? "?"}`
        ])
      })
    )
  )

  it.effect("stops chief when the wait is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/t")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* until(fake.signals, (signals) => signals.length > 0)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: undefined, signal: "SIGINT" })
        yield* Fiber.join(interrupting)
        assert.strictEqual((yield* deps.supervisor.get(run?.runId ?? ""))?.state, "interrupted")
      })
    )
  )
})

// ---- Run updates ---------------------------------------------------------------------------

const traceLine = (seq: number, at: number, kind: string, fields: TraceLine["fields"]) =>
  TraceLine.make({ schemaVersion: 1, seq, timestamp: at, runId: "r", kind, fields })

const eventLine = (seq: number, at: number, value: FlowEvent): TraceLine =>
  traceLine(seq, at, value._tag, { event: JSON.stringify(value) })

const encodeTrace = (lines: ReadonlyArray<TraceLine>): string =>
  lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n"

const planOf = (done: number): string =>
  [
    "# Plan: health",
    ...[1, 2, 3, 4].map((n) => `## [${n <= done ? "x" : " "}] Task ${n}\nDo ${n}.`)
  ].join("\n\n")

const task = "add a health check"
const planPath = `${repo.path}/${defaultPlanPath(task)}`

/** A run started from a `/bot` request, as the request half leaves it. */
const chatRun = (overrides: Partial<ChatOptions> = {}) =>
  Effect.gen(function* () {
    const fixture = yield* setup([startRun("implement", task)], overrides)
    const asked = yield* fixture.chat.add(`/bot ${task}`)
    const state = yield* handleBeat(fixture.deps, initial)
    const [run] = yield* fixture.deps.supervisor.list(repo.id)
    if (run?.tracePath === undefined) return yield* Effect.die("no run was started")
    const writeTrace = (lines: ReadonlyArray<TraceLine>) =>
      fixture.memory.store.writeAtomic(run.tracePath ?? "", encodeTrace(lines))
    const finish = Effect.gen(function* () {
      yield* fixture.fake.exit(run.pid ?? 0, { code: 0, signal: undefined })
      yield* until(fixture.deps.supervisor.get(run.runId), (latest) => latest?.state === "exited")
    })
    return { ...fixture, asked, state, run, writeTrace, finish }
  })

describe("followRun", () => {
  it.effect("posts the plan, then one throttled line for two task completions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, asked, state, run, memory, writeTrace, finish } = yield* chatRun()
        yield* writeTrace([eventLine(1, 0, Info.make({ message: "planning" }))])
        yield* memory.store.writeAtomic(planPath, planOf(1))
        const before = (yield* chat.posted).length
        let step = yield* followRun(deps, state, startFollowing(run.runId))
        yield* TestClock.adjust("10 seconds")
        yield* memory.store.writeAtomic(planPath, planOf(2))
        step = yield* followRun(deps, step.state, step.followed)
        yield* TestClock.adjust("10 seconds")
        yield* memory.store.writeAtomic(planPath, planOf(3))
        step = yield* followRun(deps, step.state, step.followed)
        assert.deepStrictEqual(texts((yield* chat.posted).slice(before)), [
          `${marker} ${run.runId}: plan written, 4 tasks`
        ])
        yield* TestClock.adjust(throttleMs - 20_000)
        step = yield* followRun(deps, step.state, step.followed)
        const posted = (yield* chat.posted).slice(before)
        assert.deepStrictEqual(texts(posted), [
          `${marker} ${run.runId}: plan written, 4 tasks`,
          `${marker} ${run.runId}: task 3 of 4 done`
        ])
        assert.deepStrictEqual(
          posted.map((p) => p.threadName),
          [asked.threadName, asked.threadName]
        )
        assert.isFalse(step.followed.done)
        yield* finish
      })
    )
  )

  it.effect("posts the ending line inside the window with branch and commits, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* chatRun()
        const { chat, asked, run, memory, writeTrace, finish } = fixture
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          git: {
            ...fixture.deps.git,
            currentBranch: Effect.succeed("llm4ts/health"),
            commitsAhead: (base) => Effect.succeed(base === "main" ? 3 : 0)
          }
        }
        yield* memory.store.writeAtomic(planPath, planOf(3))
        yield* writeTrace([eventLine(1, 0, Info.make({ message: "planning" }))])
        const before = (yield* chat.posted).length
        let step = yield* followRun(deps, fixture.state, startFollowing(run.runId))
        yield* TestClock.adjust("5 seconds")
        yield* memory.store.writeAtomic(planPath, planOf(4))
        yield* writeTrace([
          eventLine(1, 0, Info.make({ message: "planning" })),
          traceLine(2, 3 * 60_000 + 30_000, "RunEnded", { outcome: "completed" })
        ])
        yield* finish
        step = yield* followRun(deps, step.state, step.followed)
        assert.isTrue(step.followed.done)
        const ending = `${marker} ${run.runId} completed in 3 min, $0.00. Branch llm4ts/health, 3 commits.`
        const posted = (yield* chat.posted).slice(before)
        assert.deepStrictEqual(texts(posted), [
          `${marker} ${run.runId}: plan written, 4 tasks`,
          ending
        ])
        assert.strictEqual(posted[1]?.threadName, asked.threadName)
        const [request] = yield* loadRequests(memory.store, dir)
        assert.strictEqual(request?.status, "ended")
        assert.strictEqual(request?.outcome, "completed")
        // Ended already: a fresh follower, as after a restart, posts nothing.
        yield* TestClock.adjust("1 minute")
        yield* followRun(deps, step.state, startFollowing(run.runId))
        assert.strictEqual((yield* chat.posted).length - before, 2)
      })
    )
  )

  it.effect("leaves the branch out of a lost run's ending line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          git: { ...fixture.deps.git, currentBranch: Effect.succeed("someone-else") }
        }
        yield* putRequest(
          fixture.memory.store,
          dir,
          ChatRequest.make({
            messageName: "spaces/AAA/messages/old",
            createTime: "2026-11-18T09:00:00.000Z",
            sender: ownerId,
            text: "fix",
            threadName: "spaces/AAA/threads/old",
            status: "started",
            runId: "op-gone"
          })
        )
        const step = yield* followRun(deps, initial, startFollowing("op-gone"))
        assert.isTrue(step.followed.done)
        assert.deepStrictEqual(texts(yield* fixture.chat.posted), [
          `${marker} op-gone lost in 0 min, $0.00.`
        ])
      })
    )
  )

  it.effect(
    "under --observe after an armed session changes nothing and says what it would post",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* chatRun()
          const { run, memory, writeTrace, finish } = fixture
          const deps: ChatLoopDeps = {
            ...fixture.deps,
            git: { ...fixture.deps.git, currentBranch: Effect.succeed("llm4ts/health") },
            options: { ...fixture.deps.options, observe: true }
          }
          yield* writeTrace([eventLine(1, 0, Info.make({ message: "planning" }))])
          yield* finish
          const before = (yield* fixture.chat.posted).length
          yield* followRun(deps, fixture.state, startFollowing(run.runId))
          assert.strictEqual((yield* fixture.chat.posted).length, before)
          const [request] = yield* loadRequests(memory.store, dir)
          assert.strictEqual(request?.status, "started")
          assert.deepStrictEqual(yield* Ref.get(fixture.lines), [
            `would reply: ${run.runId} completed in 0 min, $0.00. Branch llm4ts/health, 0 commits.`
          ])
        })
      )
  )

  it.effect("posts summarizeTree's sentence for a story-shaped run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, asked, state, run, memory, writeTrace, finish } = yield* chatRun()
        yield* writeTrace([eventLine(1, 0, StoryStatusChanged.make({ id: "a", status: "active" }))])
        const before = (yield* chat.posted).length
        let step = yield* followRun(deps, state, startFollowing(run.runId))
        yield* TestClock.adjust("1 minute")
        step = yield* followRun(deps, step.state, step.followed)
        const fold = yield* foldTrace(memory.store, run.tracePath ?? "")
        const posted = (yield* chat.posted).slice(before)
        assert.deepStrictEqual(posted, [
          {
            text: `${marker} ${run.runId}: ${summarizeTree(fold.state, "implement")}`,
            threadName: asked.threadName
          }
        ])
        assert.strictEqual(step.followed.seq, 1)
        yield* finish
      })
    )
  )

  it.effect("posts into the starting request's thread after a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, asked, state, run, memory, writeTrace, finish } = yield* chatRun()
        yield* writeTrace([eventLine(1, 0, Info.make({ message: "planning" }))])
        yield* memory.store.writeAtomic(planPath, planOf(1))
        const before = (yield* chat.posted).length
        const first = yield* followRun(deps, state, startFollowing(run.runId))
        yield* saveState(memory.store, dir, first.state)
        const restored = yield* loadState(memory.store, dir)
        if (restored === undefined) return yield* Effect.die("no saved state")
        yield* chat.add("/bot something else")
        yield* TestClock.adjust("1 minute")
        yield* memory.store.writeAtomic(planPath, planOf(2))
        yield* followRun(deps, restored, startFollowing(run.runId))
        const posted = (yield* chat.posted).slice(before)
        assert.strictEqual(posted.length, 2)
        assert.deepStrictEqual(
          posted.map((p) => p.threadName),
          [asked.threadName, asked.threadName]
        )
        yield* finish
      })
    )
  )
})

// ---- Starting and looping ------------------------------------------------------------------

const listening = `${marker} Listening. Repository app. I may start: implement, taskforce.`

describe("startChat", () => {
  it.effect("posts the listening line and stores its sender as the owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = { ...fixture.deps, ignored: Effect.succeed(false) }
        const state = yield* startChat(deps)
        assert.deepStrictEqual(texts(yield* fixture.chat.posted), [listening])
        assert.strictEqual(state.ownerId, ownerId)
        assert.strictEqual(state.baseBranch, "main")
        assert.strictEqual(state.posted.length, 1)
        assert.strictEqual((yield* loadState(fixture.memory.store, dir))?.ownerId, ownerId)
        assert.deepStrictEqual(yield* Ref.get(fixture.lines), [
          "Warning: .llm4ts/ is not ignored by git in this repository; add it to .gitignore."
        ])
      })
    )
  )

  it.effect("takes the marker from the options over a stored one, for selecting and posting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup([answer("Nothing is running.")], { marker: "🤖 cos:" })
        yield* saveState(fixture.memory.store, dir, initial)
        const state = yield* startChat(fixture.deps)
        assert.strictEqual(state.marker, "🤖 cos:")
        assert.strictEqual((yield* loadState(fixture.memory.store, dir))?.marker, "🤖 cos:")
        yield* fixture.chat.add("/bot what is running?")
        yield* handleBeat(fixture.deps, state)
        assert.deepStrictEqual(texts(yield* fixture.chat.posted), [
          "🤖 cos: Listening. Repository app. I may start: implement, taskforce.",
          "🤖 cos: Nothing is running."
        ])
      })
    )
  )

  it.effect("under observe posts nothing and leaves the owner unset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup([], { observe: true })
        const state = yield* startChat(deps)
        assert.deepStrictEqual(yield* chat.posted, [])
        assert.isUndefined(state.ownerId)
      })
    )
  )

  it.effect("stops when gws fails its probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          chat: {
            ...fixture.deps.chat,
            probe: Effect.fail(
              ProcessError.make({ message: "gws --version", detail: "gws 0.1.0 is not supported" })
            )
          }
        }
        const error = yield* Effect.flip(startChat(deps))
        assert.instanceOf(error, ChatStopped)
        assert.include(error.message, "gws 0.1.0 is not supported")
        assert.deepStrictEqual(yield* fixture.chat.posted, [])
      })
    )
  )

  it.effect("stops when the seat only advises read-only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const problem = "the seat 'pi' only has read-only grade 'advisory'"
        const deps: ChatLoopDeps = { ...fixture.deps, seatProblem: Effect.succeed(problem) }
        const error = yield* Effect.flip(startChat(deps))
        assert.instanceOf(error, ChatStopped)
        assert.include(error.message, problem)
        assert.deepStrictEqual(yield* fixture.chat.posted, [])
      })
    )
  )

  it.effect("stops when the chief flow is not found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          flows: Effect.succeed(flows.filter((flow) => flow.name !== "chief"))
        }
        const error = yield* Effect.flip(startChat(deps))
        assert.instanceOf(error, ChatStopped)
        assert.include(error.message, "no chief flow")
        assert.deepStrictEqual(yield* fixture.chat.posted, [])
      })
    )
  )

  it.effect("stops when --flows names a flow that is not here", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup([], { flows: ["implement", "implment"] })
        const error = yield* Effect.flip(startChat(deps))
        assert.instanceOf(error, ChatStopped)
        assert.include(error.message, "implment")
        assert.notInclude(error.message, "implement,")
        assert.deepStrictEqual(yield* chat.posted, [])
      })
    )
  )

  it.effect("stops when flow discovery fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = { ...fixture.deps, flows: Effect.die("unreadable kits") }
        const error = yield* Effect.flip(startChat(deps))
        assert.instanceOf(error, ChatStopped)
        assert.include(error.message, "Cannot discover the flows")
        assert.deepStrictEqual(yield* fixture.chat.posted, [])
      })
    )
  )

  it.effect("starts a new state's cursor at now, so an older /bot is not handled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, contexts } = yield* setup([answer("New.")])
        yield* chat.add("/bot old")
        yield* TestClock.setTime(Date.parse("2026-11-18T10:00:01.500Z"))
        const state = yield* startChat(deps)
        assert.strictEqual(state.cursor, "2026-11-18T10:00:01.500Z")
        yield* chat.add("/bot new")
        yield* handleBeat(deps, state)
        assert.deepStrictEqual(
          (yield* Ref.get(contexts)).map((context) => context.request.text),
          ["new"]
        )
      })
    )
  )
})

describe("runChat", () => {
  it.effect("survives two failed lists and handles the third", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, lines } = yield* setup([answer("Hi.")])
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(chat.posted, (posted) => posted.length === 1)
        yield* chat.failWith(ProcessError.make({ message: "gws", detail: "boom" }))
        yield* TestClock.adjust("5 seconds")
        yield* until(Ref.get(lines), (all) => all.length === 1)
        yield* TestClock.adjust("1 second")
        yield* until(Ref.get(lines), (all) => all.length === 2)
        yield* chat.failWith(undefined)
        yield* chat.add("/bot hi")
        yield* TestClock.adjust("2 seconds")
        yield* until(chat.posted, (posted) => posted.length === 2)
        assert.deepStrictEqual(yield* Ref.get(lines), [
          "could not list messages in spaces/AAA: Process; retrying in 1 s",
          "could not list messages in spaces/AAA: Process; retrying in 2 s"
        ])
        assert.deepStrictEqual(texts(yield* chat.posted), [listening, `${marker} Hi.`])
        yield* Fiber.interrupt(fiber)
      })
    )
  )

  it.effect("tells the terminal when requests.md cannot be read, and keeps listening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          files: failingFiles(fixture.memory.store, { reads: "requests.md" })
        }
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(fixture.chat.posted, (posted) => posted.length === 1)
        yield* fixture.chat.add("/bot")
        yield* TestClock.adjust("5 seconds")
        yield* until(fixture.chat.posted, (posted) => posted.length === 2)
        assert.include((yield* Ref.get(fixture.lines))[0] ?? "", "could not follow runs: disk full")
        yield* Fiber.interrupt(fiber)
      })
    )
  )

  it.effect("tells the terminal when the state cannot be saved, and keeps listening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const broken = yield* Ref.make(false)
        const deps: ChatLoopDeps = {
          ...fixture.deps,
          files: failingFiles(fixture.memory.store, { writes: "state.md" }, broken)
        }
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(fixture.chat.posted, (posted) => posted.length === 1)
        yield* Ref.set(broken, true)
        yield* TestClock.adjust("5 seconds")
        yield* until(Ref.get(fixture.lines), (all) => all.length > 0)
        yield* fixture.chat.add("/bot")
        yield* TestClock.adjust("5 seconds")
        yield* until(fixture.chat.posted, (posted) => posted.length === 2)
        assert.include(
          (yield* Ref.get(fixture.lines))[0] ?? "",
          "could not save the chat state: disk full"
        )
        yield* Fiber.interrupt(fiber)
      })
    )
  )

  it.effect("ends with ChatStopped when the Google login lapses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat } = yield* setup()
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(chat.posted, (posted) => posted.length === 1)
        yield* chat.failWith(GwsLoginRequired.make({ message: "login" }))
        yield* TestClock.adjust("5 seconds")
        const error = yield* Effect.flip(Fiber.join(fiber))
        assert.deepStrictEqual(
          error,
          ChatStopped.make({ message: "Google login expired. Run: gws auth login" })
        )
      })
    )
  )

  it.effect("never announces a run not started from chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, memory } = yield* setup()
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(chat.posted, (posted) => posted.length === 1)
        const run = yield* deps.supervisor.start({
          repo,
          flow: { name: "implement", path: "/flows/implement.ts" },
          knobs: { task },
          baseEnvironment: {}
        })
        yield* memory.store.writeAtomic(
          run.tracePath ?? "",
          encodeTrace([eventLine(1, 0, StoryStatusChanged.make({ id: "a", status: "active" }))])
        )
        yield* memory.store.writeAtomic(planPath, planOf(1))
        yield* TestClock.adjust("5 seconds")
        yield* TestClock.adjust("5 seconds")
        assert.deepStrictEqual(texts(yield* chat.posted), [listening])
        yield* fake.exit(run.pid ?? 0, { code: 0, signal: undefined })
        yield* Fiber.interrupt(fiber)
      })
    )
  )

  it.effect("follows a run it started until its end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, chat, fake, memory } = yield* setup([startRun("implement", task)])
        const fiber = yield* runChat(deps).pipe(Effect.forkChild)
        yield* until(chat.posted, (posted) => posted.length === 1)
        const asked = yield* chat.add(`/bot ${task}`)
        yield* memory.store.writeAtomic(planPath, planOf(0))
        yield* TestClock.adjust("5 seconds")
        yield* until(chat.posted, (posted) => posted.length === 3)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 1, signal: undefined })
        yield* until(deps.supervisor.list(repo.id), (runs) => runs[0]?.state === "exited")
        yield* TestClock.adjust("5 seconds")
        yield* until(chat.posted, (posted) => posted.length === 4)
        const posted = (yield* chat.posted).slice(2)
        assert.deepStrictEqual(texts(posted), [
          `${marker} ${run?.runId ?? "?"}: plan written, 4 tasks`,
          // Still on the base branch: no branch sentence.
          `${marker} ${run?.runId ?? "?"} failed in 0 min, $0.00.`
        ])
        assert.deepStrictEqual(
          posted.map((p) => p.threadName),
          [asked.threadName, asked.threadName]
        )
        yield* Fiber.interrupt(fiber)
      })
    )
  )
})
