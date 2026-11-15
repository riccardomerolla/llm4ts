import { createServer as createNetServer } from "node:net"
import { request as httpRequest } from "node:http"
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as NetAddress from "effect/net/NetAddress"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { TranscriptEntry } from "@llm4ts/flow/Transcript"
import { tailLinesOf, type TailTarget } from "@llm4ts/runner/Transcripts"
import { noTranscriptMessage, replayGap } from "../src/Watch.ts"
import {
  WebFrameJson,
  WebRunJson,
  WebTranscriptJson,
  type WebFrame,
  type WebTimelineItem
} from "../src/WebFrame.ts"
import {
  contentSecurityPolicy,
  exposureNotice,
  hostAllowed,
  isLoopbackHost,
  listenFailure,
  openAddress,
  runWebWatch,
  webWatchApp,
  type WebWatchDependencies,
  type WebWatchOptions
} from "../src/WebWatch.ts"
import { initialView, renderTree, type TreeMode } from "@llm4ts/runner/AgentTree"
import { foldSteps, frameOf } from "../src/WebWatchView.ts"
import { timelineWith } from "../web-src/views.ts"
import {
  clonesFrame,
  clonesStart,
  clonesSteps,
  frameAt,
  shellFixture,
  start,
  steps,
  trace
} from "./WebWatchFixture.ts"

describe("watch --web view", () => {
  it("keeps the trace's seq on every step, and skips what the tree skips", () => {
    assert.strictEqual(steps.length, 50)
    assert.isFalse(steps.some((step) => step.seq === 5))
    assert.deepStrictEqual(
      steps.slice(4, 6).map((step) => step.seq),
      [4, 6]
    )
  })

  it("draws seq 33 from the tree's own fold: iban failed, lemonade out, nothing judged", () => {
    const frame = frameAt(33)
    assert.strictEqual(frame.seq, 33)
    assert.strictEqual(frame.stage, "implement stories")
    assert.strictEqual(frame.title, "epic conto-bonifico")
    const iban = frame.stories.find((story) => story.id === "iban")
    assert.strictEqual(iban?.status, "failed")
    assert.strictEqual(iban?.failStage, "IBAN input component")
    assert.strictEqual(iban?.failMessage, "pi error: Connection error.")
    assert.deepStrictEqual(
      frame.stories.map((story) => [story.id, story.status]),
      [
        ["accounts", "running"],
        ["payments", "running"],
        ["iban", "failed"],
        ["overview", "planned"],
        ["movimenti", "planned"],
        ["bonifico", "waiting"]
      ]
    )
    assert.deepStrictEqual(
      frame.roster.map((executor) => executor.state),
      ["busy", "busy", "out", "idle"]
    )
    assert.strictEqual(frame.verdicts.length, 0)
    assert.strictEqual(frame.counts.failed, 1)
  })

  it("keeps every verdict, the merge and the token split at the end of the run", () => {
    const frame = frameAt(50)
    assert.deepStrictEqual(
      frame.verdicts.map((verdict) => [verdict.round, verdict.cleared, verdict.seq]),
      [
        [1, false, 37],
        [2, true, 41]
      ]
    )
    assert.strictEqual(frame.merged, 1)
    assert.strictEqual(frame.counts.done, 1)
    assert.strictEqual(frame.judge.state, "waiting")
    assert.strictEqual(frame.agents, "agents · 2 running · codex ×1 · pi-lmstudio ×1")
    assert.strictEqual(frame.focus, "payments")
    const payments = frame.stories.find((story) => story.id === "payments")
    assert.strictEqual(payments?.model, "local-qwen3-coder")
    assert.deepStrictEqual([payments?.prompt, payments?.completion], [90_000, 2_500])
    assert.strictEqual(frame.costUsd > 0, true)
  })

  it("files the session log, digests and tool calls under the seq that made them", () => {
    const { timeline } = frameAt(50)
    const at = (seq: number) => timeline.filter((item) => item.seq === seq)
    assert.deepStrictEqual(
      at(32).map((item) => [item.who, item.what, item.tone]),
      [["iban", "IBAN input component failed: pi error: Connection error.", "failed"]]
    )
    assert.deepStrictEqual(
      at(41).map((item) => [item.what, item.tone]),
      [["accounts r2 · cleared → merge", "judgment"]]
    )
    assert.deepStrictEqual(
      at(22).map((item) => [item.what, item.tone]),
      [["bash pnpm test accounts", "tool"]]
    )
    assert.deepStrictEqual(
      at(36).map((item) => [item.what, item.tone]),
      [["claude → judge · accounts", "judge"]]
    )
  })

  it("waits as watch --replay does: the gap, at most two seconds, sped up", () => {
    assert.strictEqual(replayGap(0, 500, 10), 50)
    assert.strictEqual(replayGap(0, 137_000, 10), 200)
    assert.strictEqual(replayGap(0, 137_000, 1), 2_000)
    assert.strictEqual(replayGap(10, 10, 50), 0)
  })
})

/** What the terminal tree prints in `mode` for the same fold; its boxes cut long lines with `…`. */
const terminal = (seq: number, mode: TreeMode): string =>
  renderTree(
    foldSteps(
      start,
      steps.filter((step) => step.seq <= seq)
    ).state,
    {
      width: 160,
      colour: false,
      view: { ...initialView, mode }
    }
  ).join("\n")

describe("watch --web executors and boards", () => {
  it("gives every executor its leases, and lemonade's reason at seq 33, as the executor boxes do", () => {
    const frame = frameAt(33)
    assert.deepStrictEqual(
      frame.roster.map((executor) => [
        executor.name,
        executor.state,
        executor.leases,
        executor.reason
      ]),
      [
        ["codex", "busy", ["coder · accounts"], undefined],
        ["pi-lmstudio", "busy", ["coder · payments"], undefined],
        ["lemonade", "out", ["coder · iban"], "until 10:05: the serving engine is down"],
        ["claude", "idle", [], undefined]
      ]
    )
    const boxes = terminal(33, "executors")
    for (const executor of frame.roster) {
      for (const lease of executor.leases) {
        assert.include(boxes, lease)
      }
    }
    assert.include(boxes, `✗ out: ${frame.roster[2]?.reason?.slice(0, 12)}`)
  })

  it("keeps lemonade out with no lease at the end, and codex moved to overview", () => {
    assert.deepStrictEqual(
      frameAt(50).roster.map((executor) => [executor.name, executor.state, executor.leases]),
      [
        ["codex", "busy", ["coder · overview"]],
        ["pi-lmstudio", "busy", ["coder · payments"]],
        ["lemonade", "out", []],
        ["claude", "idle", []]
      ]
    )
  })

  it("puts each story in the epic board's column with the clone the terminal's card shows", () => {
    const columns = (seq: number) =>
      frameAt(seq).stories.map((story) => [story.id, story.status, story.clone])
    assert.deepStrictEqual(columns(33), [
      ["accounts", "running", "codex"],
      ["payments", "running", "pi-lmstudio"],
      ["iban", "failed", "lemonade"],
      ["overview", "planned", undefined],
      ["movimenti", "planned", undefined],
      ["bonifico", "waiting", undefined]
    ])
    assert.deepStrictEqual(columns(50), [
      ["accounts", "done", "codex"],
      ["payments", "running", "pi-lmstudio"],
      ["iban", "failed", "lemonade"],
      ["overview", "running", "codex"],
      ["movimenti", "planned", undefined],
      ["bonifico", "waiting", undefined]
    ])
    for (const seq of [33, 50]) {
      const frame = frameAt(seq)
      const boards = terminal(seq, "boards")
      const focus = frame.stories.find((story) => story.id === frame.focus)
      assert.include(boards, `story board · ${focus?.id} · ${focus?.clone}`, `seq ${seq}`)
      for (const story of frame.stories.filter((candidate) => candidate.status === "running")) {
        assert.match(boards, new RegExp(`│ +${story.clone} +│`, "u"), `seq ${seq} ${story.id}`)
      }
    }
  })

  it("files a story's tasks in the story board's columns, as the boards golden does", () => {
    const frame = clonesFrame()
    const s01 = frame.stories.find((story) => story.id === "S01")
    assert.strictEqual(s01?.clone, "codex#1")
    assert.deepStrictEqual(
      s01?.tasks.map((task) => [task.index, task.column]),
      [
        [1, "done"],
        [2, "done"],
        [3, "doing"],
        [4, "todo"],
        [5, "todo"]
      ]
    )
    assert.deepStrictEqual(
      frame.stories
        .filter((story) => story.status === "running")
        .map((story) => [
          story.id,
          story.clone,
          story.tasks.filter((task) => task.column === "done").length,
          story.tasks.length
        ]),
      [
        ["S01", "codex#1", 2, 5],
        ["S02", "codex#2", 0, 4],
        ["S03", "claude#1", 1, 3],
        ["S04", "codex#3", 5, 5],
        ["S05", "(leasing)", 0, 0]
      ]
    )
    const boards = renderTree(foldSteps(clonesStart, clonesSteps).state, {
      width: 160,
      colour: false,
      view: { ...initialView, mode: "boards" }
    }).join("\n")
    for (const task of s01?.tasks ?? []) {
      assert.include(boards, `${task.index} ${task.title}`.slice(0, 20))
    }
  })
})

/** What the terminal tree prints for the same fold with the reader's view. */
const terminalWith = (
  state: ReturnType<typeof foldSteps>["state"],
  view: Partial<typeof initialView>
): string =>
  renderTree(state, { width: 160, colour: false, view: { ...initialView, ...view } }).join("\n")

describe("watch --web expanded detail and full log", () => {
  it("carries every stage and the tools the expanded detail box lists, for each running story", () => {
    const folds = [
      foldSteps(
        start,
        steps.filter((step) => step.seq <= 50)
      ),
      foldSteps(clonesStart, clonesSteps)
    ]
    let checked = 0
    for (const fold of folds) {
      const frame = frameOf(fold, { steps: 0, lastSeq: undefined })
      for (const story of frame.stories.filter((candidate) => candidate.status === "running")) {
        const lane = fold.state.lanes.find((candidate) => candidate.id === story.id)
        assert.deepStrictEqual(story.stages, lane?.stages, story.id)
        assert.deepStrictEqual(story.tools, lane?.tools, story.id)
        const box = terminalWith(fold.state, { selected: story.id, expanded: true })
        for (const stage of story.stages) {
          assert.isTrue(
            box.split("\n").some((line) => line.includes(`│ ${stage} `)),
            `${story.id} ${stage}`
          )
        }
        if (story.tools.length > 0) {
          assert.include(box, `tools (last ${story.tools.length})`, story.id)
          for (const tool of story.tools) {
            assert.include(box, `  ${tool}`.slice(0, 40), story.id)
          }
        }
        checked += 1
      }
    }
    assert.isAtLeast(checked, 5)
  })

  it("builds the whole log from each frame's latest items, and holds every line of the terminal's full log", () => {
    let known: ReadonlyArray<WebTimelineItem> = []
    for (const step of steps) {
      const frame = frameAt(step.seq)
      known = timelineWith(known, frame.timeline, frame.timelineCount) ?? []
    }
    const fold = foldSteps(start, steps)
    assert.deepStrictEqual(known, fold.timeline)
    const full = terminalWith(fold.state, { fullLog: true })
    const short = terminalWith(fold.state, {})
    assert.isAbove(full.split("\n").length, short.split("\n").length)
    for (const entry of fold.state.log) {
      assert.isTrue(
        known.some((item) => item.who === entry.who && item.what === entry.what),
        `${entry.who} ${entry.what}`
      )
      assert.include(full, entry.what.slice(0, 30))
    }
  })

  it("says when a frame's latest items skip past what the page holds, so it asks again", () => {
    const items = foldSteps(start, steps).timeline
    assert.isUndefined(timelineWith(items.slice(0, 5), items.slice(10, 12), 12))
    assert.deepStrictEqual(
      timelineWith(items.slice(0, 10), items.slice(8, 12), 12),
      items.slice(0, 12)
    )
    assert.deepStrictEqual(timelineWith(items, items.slice(0, 3), 3), items.slice(0, 3))
  })
})

describe("watch --web frame schema", () => {
  const throughTheWire = (frame: WebFrame): WebFrame =>
    Schema.decodeUnknownSync(WebFrameJson)(Schema.encodeSync(WebFrameJson)(frame))

  it("round-trips every frame of the fixture run, as JSON, unchanged", () => {
    for (const seq of [1, 22, 33, 41, 50]) {
      const frame = frameAt(seq)
      assert.strictEqual(JSON.stringify(throughTheWire(frame)), JSON.stringify(frame), `seq ${seq}`)
    }
    const clones = clonesFrame()
    assert.strictEqual(JSON.stringify(throughTheWire(clones)), JSON.stringify(clones), "clones")
    const iban = throughTheWire(frameAt(33)).stories.find((story) => story.id === "iban")
    assert.strictEqual(iban?.failMessage, "pi error: Connection error.")
  })

  it("refuses a frame whose story status the tree does not have", () => {
    const frame = JSON.parse(JSON.stringify(frameAt(33)))
    frame.stories[0].status = "exploded"
    assert.throws(() => Schema.decodeUnknownSync(WebFrameJson)(JSON.stringify(frame)))
  })
})

const epicDir = "/repo/.llm4ts/epics/conto"
const tracePath = "/repo/.llm4ts/trace-1790000000000.jsonl"
const ended = `${trace}${JSON.stringify({
  schemaVersion: 1,
  seq: 99,
  timestamp: 1_790_000_500_000,
  runId: "run-fixture",
  kind: "RunEnded",
  fields: { outcome: "completed" }
})}\n`

/** The page's files as the tests serve them: the real page, and a font of known bytes. */
const fontBytes = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x80, 0x0a])
const testAssets: Readonly<Record<string, Uint8Array>> = {
  "index.html": readFileSync(new URL("../web/index.html", import.meta.url)),
  "app.js": new TextEncoder().encode('new EventSource("/api/stream")'),
  "fonts/Geist-Variable.woff2": fontBytes
}

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(TranscriptEntry))
const transcriptDir = "/repo/.llm4ts/transcripts/run-fixture"
const at = (offset: number): number => 1_790_000_000_000 + offset
/** payments: a coder call during its task, and a reviewer call after seq 35; claude's judge call on accounts. */
const paymentsEntries: ReadonlyArray<TranscriptEntry> = [
  {
    _tag: "Call",
    at: at(20_000),
    call: "c1",
    role: "coder",
    executor: "pi-lmstudio",
    input: "Add the fake routes"
  },
  { _tag: "Reply", at: at(21_000), call: "c1", text: "Writing payments.fake.ts" },
  { _tag: "Tool", at: at(23_000), call: "c1", tool: "bash", args: '{"command":"pnpm test"}' },
  { _tag: "ToolResult", at: at(25_000), call: "c1", output: "3 passed" },
  { _tag: "End", at: at(26_000), call: "c1", ms: 6_000 },
  {
    _tag: "Call",
    at: at(300_500),
    call: "c2",
    role: "reviewer",
    executor: "pi-lmstudio",
    input: "Review the fake routes"
  },
  { _tag: "Reply", at: at(301_000), call: "c2", text: "Looks right" },
  { _tag: "End", at: at(302_000), call: "c2", ms: 1_500 }
]
const accountsEntries: ReadonlyArray<TranscriptEntry> = [
  {
    _tag: "Call",
    at: at(321_000),
    call: "j1",
    role: "judge",
    executor: "claude",
    input: "Judge accounts"
  },
  { _tag: "Reply", at: at(322_000), call: "j1", text: "two issues" },
  { _tag: "End", at: at(329_000), call: "j1", ms: 8_000 }
]
const transcriptFiles: Readonly<Record<string, string>> = {
  [`${transcriptDir}/payments.jsonl`]: `${paymentsEntries.map((entry) => encodeEntry(entry)).join("\n")}\n`,
  [`${transcriptDir}/accounts.jsonl`]: `${accountsEntries.map((entry) => encodeEntry(entry)).join("\n")}\n`,
  "/repo/.llm4ts/secret.jsonl": `${encodeEntry({ _tag: "Call", at: 1, call: "x", role: "coder", input: "SECRET" })}\n`
}

const dependenciesFor = (
  contents: string,
  transcripts: Readonly<Record<string, string>> = transcriptFiles
) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore({
      [tracePath]: contents,
      [`${epicDir}/board.json`]: shellFixture("agent-tree.board.json"),
      [`${epicDir}/runs.jsonl`]: `${JSON.stringify({
        runId: "run-fixture",
        tracePath,
        action: "RunPlan",
        startedAt: 1
      })}\n`
    })
    const written = yield* Ref.make("")
    const reads = yield* Ref.make<ReadonlyArray<string>>([])
    const detached = yield* Deferred.make<void>()
    const dependencies: WebWatchDependencies = {
      files: memory.store,
      listTraces: () => [tracePath],
      listEpics: (directory) => (directory === "/repo/.llm4ts/epics" ? ["conto"] : []),
      write: (text) => Ref.update(written, (all) => all + text),
      asset: (file) => testAssets[file],
      detach: Deferred.await(detached),
      transcripts: {
        read: (path) =>
          Effect.as(
            Ref.update(reads, (all) => [...all, path]),
            transcripts[path]
          ),
        list: (directory) =>
          Object.keys(transcripts)
            .filter((path) => path.startsWith(`${directory}/`))
            .map((path) => path.slice(directory.length + 1))
      }
    }
    return { dependencies, written, reads, detach: Deferred.succeed(detached, undefined) }
  })

const port = 4321
/** The server the app is mounted on, as far as the app can tell: its address. */
const listening = Layer.succeed(HttpServer.HttpServer)(
  HttpServer.make({
    serve: () => Effect.void,
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", port)
  })
)

const serve = (
  options: WebWatchOptions,
  contents: string = trace,
  transcripts: Readonly<Record<string, string>> = transcriptFiles
) =>
  Effect.gen(function* () {
    const { dependencies } = yield* serveDependencies(contents, transcripts)
    const app = yield* webWatchApp(options, dependencies)
    const { dispose, handler } = HttpRouter.toWebHandler(Layer.provide(app, listening), {
      disableLogger: true
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    return (path: string, host = `127.0.0.1:${port}`) =>
      Effect.promise(() =>
        handler(new Request(`http://127.0.0.1:${port}${path}`, { headers: { host } }))
      )
  })

/** Each `serve` records the transcript reads it makes here, for the traversal test. */
let lastReads: Ref.Ref<ReadonlyArray<string>> | undefined
const serveDependencies = (contents: string, transcripts: Readonly<Record<string, string>>) =>
  Effect.tap(dependenciesFor(contents, transcripts), (made) =>
    Effect.sync(() => {
      lastReads = made.reads
    })
  )

const text = (response: Response) => Effect.promise(() => response.text())
const bytes = (response: Response) =>
  Effect.promise(() => response.arrayBuffer().then((body) => new Uint8Array(body)))
const decoded = <S extends Schema.Decoder<unknown>>(codec: S, response: Response) =>
  Effect.map(text(response), (body) => Schema.decodeUnknownSync(codec)(body))

const framesOf = (body: string): ReadonlyArray<WebFrame> =>
  body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("event: frame"))
    .map((chunk) =>
      Schema.decodeUnknownSync(WebFrameJson)(chunk.slice(chunk.indexOf("data: ") + 6))
    )

describe("watch --web server", () => {
  it.effect("serves the page under its CSP, and the run through the shared schema", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true })
      const page = yield* get("/")
      assert.strictEqual(page.status, 200)
      assert.include(page.headers.get("content-type") ?? "", "text/html")
      assert.strictEqual(page.headers.get("content-security-policy"), contentSecurityPolicy)
      assert.strictEqual(page.headers.get("x-content-type-options"), "nosniff")
      const html = yield* text(page)
      assert.include(html, "llm4ts watch --replay")
      assert.notInclude(html, "fonts.googleapis.com")
      assert.notInclude(html, "style=")
      assert.include(yield* text(yield* get("/app.js")), "/api/stream")
      const run = yield* decoded(WebRunJson, yield* get("/api/run"))
      assert.strictEqual(run.mode, "replay")
      assert.strictEqual(run.trace, "trace-1790000000000.jsonl")
      assert.strictEqual(run.speed, 10)
      assert.strictEqual(run.steps.length, 50)
      assert.strictEqual(run.lastSeq, 50)
      const frame = yield* decoded(WebFrameJson, yield* get("/api/frame?count=33"))
      assert.strictEqual(frame.seq, 33)
      assert.strictEqual(frame.title, "epic conto-bonifico")
      assert.strictEqual((yield* get("/api/frame?count=lots")).status, 400)
      assert.strictEqual((yield* get("/favicon.ico")).status, 204)
    }).pipe(Effect.scoped)
  )

  it.effect("serves a font byte for byte, as woff2", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true })
      const font = yield* get("/fonts/Geist-Variable.woff2")
      assert.strictEqual(font.status, 200)
      assert.strictEqual(font.headers.get("content-type"), "font/woff2")
      assert.deepStrictEqual(yield* bytes(font), fontBytes)
      assert.strictEqual((yield* get("/fonts/GeistMono-Variable.woff2")).status, 404)
    }).pipe(Effect.scoped)
  )

  it.effect("answers only the loopback names of its own port", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true })
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        assert.strictEqual((yield* get("/api/run", host)).status, 200, host)
      }
      for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1:9999", "localhost"]) {
        for (const path of ["/", "/api/run", "/api/frame?count=1", "/api/stream", "/nope"]) {
          const refused = yield* get(path, host)
          assert.strictEqual(refused.status, 403, `${host} ${path}`)
          assert.notInclude(yield* text(refused), "conto", `${host} ${path}`)
        }
      }
    }).pipe(Effect.scoped)
  )

  it.effect("bound to every interface, also answers an IP address, never a foreign name", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true, host: "0.0.0.0" })
      for (const host of [`127.0.0.1:${port}`, `192.168.1.20:${port}`, `[fe80::1]:${port}`]) {
        assert.strictEqual((yield* get("/api/run", host)).status, 200, host)
      }
      for (const host of [`evil.example:${port}`, `192.168.1.20:9999`, "192.168.1.20"]) {
        assert.strictEqual((yield* get("/api/run", host)).status, 403, host)
      }
    }).pipe(Effect.scoped)
  )

  it.effect("plays a replay from a step to the last, each frame after its gap", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true, speed: 10_000 })
      const response = yield* get("/api/stream?count=46&speed=10000")
      assert.include(response.headers.get("content-type") ?? "", "text/event-stream")
      const body = yield* text(response)
      const frames = framesOf(body)
      assert.deepStrictEqual(
        frames.map((frame) => frame.seq),
        [46, 47, 48, 49, 50]
      )
      assert.strictEqual(frames[0]?.gapMs, 0)
      assert.isTrue(body.trimEnd().endsWith("event: end\ndata: {}"))
    }).pipe(Effect.scoped)
  )

  it.effect("follows a live run until its trace says it ended", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath }, ended)
      const run = yield* decoded(WebRunJson, yield* get("/api/run"))
      assert.strictEqual(run.mode, "live")
      const frames = framesOf(yield* text(yield* get("/api/stream")))
      assert.strictEqual(frames.length, 1)
      assert.strictEqual(frames[0]?.ended, "completed")
      assert.strictEqual(frames[0]?.count, 51)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses before serving when the trace is missing", () =>
    Effect.gen(function* () {
      const { dependencies, written } = yield* dependenciesFor(trace)
      const error = yield* Effect.flip(
        runWebWatch({ repo: "/repo", trace: "/repo/.llm4ts/nope.jsonl" }, dependencies)
      )
      assert.include(error.message, "trace does not exist")
      assert.strictEqual(yield* Ref.get(written), "")
    })
  )
})

/** A GET on the real loopback server; resolves with the status once the headers arrive. */
const openGet = (
  url: URL,
  host: string
): Promise<{ readonly status: number; readonly close: () => void }> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { headers: { host } }, (incoming) => {
      resolve({ status: incoming.statusCode ?? 0, close: () => incoming.destroy() })
    })
    outgoing.on("error", reject)
    outgoing.end()
  })

const tailOf = (target: TailTarget, role?: string, until?: number) =>
  tailLinesOf(
    [...paymentsEntries, ...accountsEntries]
      .filter((entry) =>
        "lane" in target
          ? (target.lane === "payments" ? paymentsEntries : accountsEntries).includes(entry)
          : true
      )
      .filter((entry) => until === undefined || entry.at <= until)
      .sort((left, right) => left.at - right.at),
    target,
    role,
    52,
    400
  )

describe("watch --web transcript tail", () => {
  it.effect("answers a story's tail with watch's own lines, and keeps to a role", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath })
      const all = yield* decoded(
        WebTranscriptJson,
        yield* get("/api/transcript?target=payments&of=story")
      )
      assert.strictEqual(all._tag, "Lines")
      assert.deepStrictEqual(all._tag === "Lines" ? all.lines : [], tailOf({ lane: "payments" }))
      const lines = all._tag === "Lines" ? all.lines.join("\n") : ""
      assert.include(lines, "coder · pi-lmstudio")
      assert.include(lines, "◀ Writing payments.fake.ts")
      assert.include(lines, "reviewer · pi-lmstudio")
      const reviewer = yield* decoded(
        WebTranscriptJson,
        yield* get("/api/transcript?target=payments&of=story&role=reviewer")
      )
      assert.deepStrictEqual(
        reviewer._tag === "Lines" ? reviewer.lines : [],
        tailOf({ lane: "payments" }, "reviewer")
      )
      assert.notInclude(reviewer._tag === "Lines" ? reviewer.lines.join("\n") : "", "Writing")
      assert.strictEqual(reviewer._tag === "Lines" ? reviewer.role : undefined, "reviewer")
      const reads = lastReads === undefined ? [] : yield* Ref.get(lastReads)
      assert.isAbove(reads.length, 0)
      assert.deepStrictEqual([...new Set(reads)], [`${transcriptDir}/payments.jsonl`])
    }).pipe(Effect.scoped)
  )

  it.effect("tails an executor across the stories it served", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath })
      const claude = yield* decoded(
        WebTranscriptJson,
        yield* get("/api/transcript?target=claude&of=executor")
      )
      assert.deepStrictEqual(
        claude._tag === "Lines" ? claude.lines : [],
        tailOf({ executor: "claude" })
      )
      assert.include(claude._tag === "Lines" ? claude.lines.join("\n") : "", "◀ two issues")
      assert.notInclude(claude._tag === "Lines" ? claude.lines.join("\n") : "", "Writing")
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a target the run does not have, a bad role, and a path in the target", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath })
      for (const query of [
        "target=nobody&of=story",
        "target=claude&of=story",
        "target=payments&of=executor",
        "target=..%2Fsecret&of=story",
        "target=../secret&of=story",
        "target=%2e%2e%2fsecret&of=story",
        "target=%2Frepo%2F.llm4ts%2Fsecret&of=story",
        "target=..&of=story"
      ]) {
        const refused = yield* get(`/api/transcript?${query}`)
        assert.strictEqual(refused.status, 404, query)
        assert.notInclude(yield* text(refused), "SECRET", query)
      }
      for (const query of [
        "of=story",
        "target=&of=story",
        "target=payments",
        "target=payments&of=file",
        "target=payments&of=story&role=boss",
        "target=payments&of=story&count=many"
      ]) {
        assert.strictEqual((yield* get(`/api/transcript?${query}`)).status, 400, query)
      }
      const reads = lastReads === undefined ? [] : yield* Ref.get(lastReads)
      assert.deepStrictEqual(reads, [])
      assert.strictEqual(
        (yield* get("/api/transcript?target=payments&of=story", "evil.example")).status,
        403
      )
    }).pipe(Effect.scoped)
  )

  it.effect("says what the terminal says when the run kept no transcript", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath }, trace, {})
      const none = yield* decoded(
        WebTranscriptJson,
        yield* get("/api/transcript?target=payments&of=story")
      )
      assert.deepStrictEqual(none, { _tag: "None", message: noTranscriptMessage })
    }).pipe(Effect.scoped)
  )

  it.effect("cuts a replay's tail at the time of the step on screen", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true })
      const count = steps.filter((step) => step.seq <= 33).length
      const until = steps[count - 1]?.at
      const early = yield* decoded(
        WebTranscriptJson,
        yield* get(`/api/transcript?target=payments&of=story&count=${count}`)
      )
      assert.deepStrictEqual(
        early._tag === "Lines" ? early.lines : [],
        tailOf({ lane: "payments" }, undefined, until)
      )
      assert.notInclude(early._tag === "Lines" ? early.lines.join("\n") : "", "reviewer")
      const later = yield* decoded(
        WebTranscriptJson,
        yield* get(`/api/transcript?target=payments&of=story&count=${steps.length}`)
      )
      assert.include(later._tag === "Lines" ? later.lines.join("\n") : "", "reviewer")
      // At step 3 the roster has no claude yet: the target is checked against the fold on screen.
      const before = yield* get("/api/transcript?target=claude&of=executor&count=3")
      assert.strictEqual(before.status, 404)
    }).pipe(Effect.scoped)
  )
})

describe("watch --web --host", () => {
  it("allows the loopback names, the bound address, and any IP on a wildcard bind", () => {
    const cases: ReadonlyArray<readonly [string | undefined, string, boolean]> = [
      ["127.0.0.1:4000", "127.0.0.1", true],
      ["LOCALHOST:4000", "127.0.0.1", true],
      ["[::1]:4000", "127.0.0.1", true],
      ["127.0.0.1:4001", "127.0.0.1", false],
      ["127.0.0.1", "127.0.0.1", false],
      [undefined, "127.0.0.1", false],
      ["192.168.1.20:4000", "127.0.0.1", false],
      ["192.168.1.20:4000", "192.168.1.20", true],
      ["10.0.0.7:4000", "192.168.1.20", false],
      ["devbox.lan:4000", "devbox.lan", true],
      ["evil.example:4000", "devbox.lan", false],
      ["10.0.0.7:4000", "0.0.0.0", true],
      ["[fe80::1]:4000", "::", true],
      ["[fe80::1]:4000", "[::]", true],
      ["evil.example:4000", "0.0.0.0", false],
      ["evil.example:4000", "::", false]
    ]
    for (const [header, bound, allowed] of cases) {
      assert.strictEqual(hostAllowed(header, 4000, bound), allowed, `${header} on ${bound}`)
    }
  })

  it("opens a wildcard bind on loopback, and names why listening failed", () => {
    assert.strictEqual(openAddress("http://0.0.0.0:4174"), "http://127.0.0.1:4174")
    assert.strictEqual(openAddress("http://[::]:4174"), "http://[::1]:4174")
    assert.strictEqual(openAddress("http://192.168.1.20:4174"), "http://192.168.1.20:4174")
    assert.strictEqual(
      listenFailure("::1", 80, Object.assign(new Error("listen EACCES"), { code: "EACCES" })),
      "watch --web cannot listen on [::1]:80: not allowed to listen there"
    )
    assert.strictEqual(
      listenFailure("10.9.9.9", 4174, Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" })),
      "watch --web cannot listen on 10.9.9.9:4174: this machine has no such address"
    )
    assert.strictEqual(
      listenFailure("127.0.0.1", undefined, new Error("something odd")),
      "watch --web cannot listen on 127.0.0.1:0: something odd"
    )
  })

  it("warns only when the bind reaches beyond this machine", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) {
      assert.isTrue(isLoopbackHost(host), host)
      assert.strictEqual(exposureNotice(host), "", host)
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "devbox.lan"]) {
      assert.isFalse(isLoopbackHost(host), host)
      assert.include(exposureNotice(host), `Listening on ${host}, not loopback`, host)
    }
  })
})

/** A port nothing listens on right now. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const chosen = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })

describe("watch --web on a real socket", () => {
  it.live("listens on the --port and --host it is given", () =>
    Effect.gen(function* () {
      const wanted = yield* Effect.promise(freePort)
      const { dependencies, written, detach } = yield* dependenciesFor(trace)
      const serving = yield* Effect.forkChild(
        runWebWatch(
          { repo: "/repo", trace: tracePath, replay: true, host: "127.0.0.1", port: wanted },
          dependencies
        )
      )
      for (;;) {
        if ((yield* Ref.get(written)).includes("open http://")) break
        yield* Effect.sleep("10 millis")
      }
      assert.include(yield* Ref.get(written), `open http://127.0.0.1:${wanted}/`)
      assert.notInclude(yield* Ref.get(written), "not loopback")
      const run = yield* Effect.promise(() =>
        openGet(new URL(`http://127.0.0.1:${wanted}/api/run`), `localhost:${wanted}`)
      )
      run.close()
      assert.strictEqual(run.status, 200)
      yield* detach
      assert.strictEqual((yield* Fiber.await(serving))._tag, "Success")
    })
  )

  it.live("fails, without serving, when the --port is taken", () =>
    Effect.gen(function* () {
      const wanted = yield* Effect.promise(freePort)
      const holder = createNetServer()
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          holder.listen(wanted, "127.0.0.1", () => resume(Effect.void))
        }),
        () =>
          Effect.callback<void>((resume) => {
            holder.close(() => resume(Effect.void))
          })
      )
      const { dependencies, written } = yield* dependenciesFor(trace)
      const error = yield* Effect.flip(
        runWebWatch(
          { repo: "/repo", trace: tracePath, host: "127.0.0.1", port: wanted },
          dependencies
        )
      )
      assert.strictEqual(error._tag, "WebListen")
      assert.strictEqual(
        error.message,
        `watch --web cannot listen on 127.0.0.1:${wanted}: the port is in use (pick another --port, or 0 for a free one)`
      )
      assert.notInclude(yield* Ref.get(written), "open http://")
    }).pipe(Effect.scoped)
  )

  it.live("refuses a foreign Host, and detaches cleanly with a live stream open", () =>
    Effect.gen(function* () {
      const { dependencies, written, detach } = yield* dependenciesFor(trace)
      const serving = yield* Effect.forkChild(
        runWebWatch({ repo: "/repo", trace: tracePath }, dependencies)
      )
      const address = yield* Effect.gen(function* () {
        for (;;) {
          const match = /open (http:\/\/127\.0\.0\.1:\d+)\//u.exec(yield* Ref.get(written))
          if (match?.[1] !== undefined) {
            return new URL(match[1])
          }
          yield* Effect.sleep("10 millis")
        }
      })
      const foreign = yield* Effect.promise(() =>
        openGet(new URL("/api/run", address), "evil.example")
      )
      foreign.close()
      assert.strictEqual(foreign.status, 403)
      const stream = yield* Effect.promise(() =>
        openGet(new URL("/api/stream", address), address.host)
      )
      assert.strictEqual(stream.status, 200)
      yield* detach
      const exit = yield* Fiber.await(serving)
      stream.close()
      assert.strictEqual(exit._tag, "Success")
      assert.isTrue((yield* Ref.get(written)).endsWith("detached\n"))
    })
  )
})
