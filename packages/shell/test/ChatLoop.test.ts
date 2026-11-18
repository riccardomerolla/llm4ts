import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { ChiefAction, ChiefContext, failedReply } from "@llm4ts/flow/ChiefAction"
import { ProcessError } from "@llm4ts/flow/FlowError"
import type { GitToolShape } from "@llm4ts/flow/GitTool"
import { ChatMessage, GwsLoginRequired, SpaceRef } from "@llm4ts/flow/GoogleChatTool"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  decideThroughFlow,
  handleBeat,
  helpReply,
  selectRequests,
  strangerReply,
  type ChatLoopDeps,
  type ChatOptions
} from "@llm4ts/shell/ChatLoop"
import { ChatState, chatDir, loadRequests, loadState, saveState } from "@llm4ts/shell/ChatState"
import { makeFakeFlowProcess } from "@llm4ts/shell/FlowProcess"
import { makeRunSupervisor, type SupervisorRepo } from "@llm4ts/shell/RunSupervisor"
import { makeFakeChat, ownerId } from "./support/FakeChat.ts"

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

const unused = Effect.die("unused in these tests")

const fakeGit = (
  log: Ref.Ref<ReadonlyArray<string>>,
  dirty: Ref.Ref<ReadonlyArray<string>>
): GitToolShape => {
  const ok = Effect.void
  return {
    init: ok,
    initBare: ok,
    config: () => ok,
    status: Effect.succeed(""),
    uncommittedFiles: Ref.get(dirty),
    currentBranch: Effect.succeed("main"),
    diff: Effect.succeed(""),
    diffAll: Effect.succeed(""),
    defaultBase: Effect.succeed("main"),
    diffVsBase: () => Effect.succeed(""),
    diffVsBaseScoped: () => Effect.succeed(""),
    listFiles: () => Effect.succeed([]),
    changedFilesVsBase: () => Effect.succeed([]),
    addRemote: () => ok,
    checkout: (name) => Ref.update(log, (all) => [...all, `checkout:${name}`]),
    checkoutOrCreate: () => ok,
    createBranch: () => unused,
    commitAll: () => unused,
    commitPaths: () => unused,
    push: () => ok,
    checkpoint: Effect.succeed("before"),
    rollback: () => ok,
    addWorktree: () => ok,
    addWorktreeNewBranch: () => ok,
    removeWorktree: () => ok,
    moveWorktree: () => ok,
    restorePaths: () => ok,
    branchExists: () => Effect.succeed(true),
    deleteBranch: () => ok,
    isAncestor: () => Effect.succeed(true),
    commitsAhead: () => Effect.succeed(0),
    merge: () => ok,
    mergeNoCommit: () => Effect.succeed([])
  }
}

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
      now: Effect.succeed(Date.parse("2026-11-18T11:00:00.000Z")),
      say: (line) => Ref.update(lines, (all) => [...all, line]),
      strangers,
      options: { ...options, ...overrides }
    }
    return { deps, memory, fake, chat, gitLog, dirty, lines, contexts }
  })

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
        assert.deepStrictEqual(texts(yield* chat.posted).slice(1), [`${marker} Stopping it.`])
        assert.strictEqual((yield* deps.supervisor.get(runId))?.state, "interrupted")
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
        const { deps, fake } = yield* setup()
        const fiber = yield* decideThroughFlow(deps)(contextFor("spaces/AAA/messages/q")).pipe(
          Effect.forkChild
        )
        yield* until(fake.started, (started) => started.length > 0)
        const [run] = yield* deps.supervisor.list(repo.id)
        yield* fake.exit(run?.pid ?? 0, { code: 0, signal: undefined })
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "Failed", reply: failedReply })
      })
    )
  )

  it.effect("is Failed on a non-zero exit even with an action file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps, fake, memory } = yield* setup()
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
      })
    )
  )
})
