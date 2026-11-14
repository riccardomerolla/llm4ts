import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { emptyTree } from "@llm4ts/runner/AgentTree"
import { replayGap } from "../src/Watch.ts"
import {
  nodeWebAsset,
  runWebWatch,
  webWatchApp,
  type WebRun,
  type WebWatchDependencies,
  type WebWatchOptions
} from "../src/WebWatch.ts"
import { foldSteps, frameOf, stepsOfTrace, type WebFrame } from "../src/WebWatchView.ts"

const runnerFixture = (name: string): string =>
  readFileSync(new URL(`../../runner/test/fixtures/${name}`, import.meta.url), "utf8")
const shellFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const trace = runnerFixture("agent-tree.trace.jsonl")
const lines = trace
  .trim()
  .split("\n")
  .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))(line))
const steps = stepsOfTrace(lines)
const start = emptyTree({
  title: "epic conto-bonifico",
  stories: [
    { id: "accounts", status: "done" },
    { id: "payments", status: "active" },
    { id: "iban", status: "failed" },
    { id: "overview", status: "active" },
    { id: "movimenti", status: "planned" },
    { id: "bonifico", status: "waiting" }
  ]
})

/** The frame after every step up to and including `seq`. */
const frameAt = (seq: number): WebFrame =>
  frameOf(
    foldSteps(
      start,
      steps.filter((step) => step.seq <= seq)
    ),
    { steps: steps.length, lastSeq: 50 }
  )

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

const dependenciesFor = (contents: string) =>
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
    const dependencies: WebWatchDependencies = {
      files: memory.store,
      listTraces: () => [tracePath],
      listEpics: (directory) => (directory === "/repo/.llm4ts/epics" ? ["conto"] : []),
      write: (text) => Ref.update(written, (all) => all + text),
      asset: nodeWebAsset,
      detach: Effect.void
    }
    return { dependencies, written }
  })

const serve = (options: WebWatchOptions, contents: string = trace) =>
  Effect.gen(function* () {
    const { dependencies } = yield* dependenciesFor(contents)
    const app = yield* webWatchApp(options, dependencies)
    const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    return (path: string) => Effect.promise(() => handler(new Request(`http://127.0.0.1${path}`)))
  })

const text = (response: Response) => Effect.promise(() => response.text())
const json = <A>(response: Response) => Effect.map(text(response), (body): A => JSON.parse(body))

const framesOf = (body: string): ReadonlyArray<WebFrame> =>
  body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("event: frame"))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)))

describe("watch --web server", () => {
  it.effect("serves the page, and the run with its epic's board", () =>
    Effect.gen(function* () {
      const get = yield* serve({ repo: "/repo", trace: tracePath, replay: true })
      const page = yield* get("/")
      assert.strictEqual(page.status, 200)
      assert.include(page.headers.get("content-type") ?? "", "text/html")
      assert.include(yield* text(page), "llm4ts watch --replay")
      assert.include(yield* text(yield* get("/app.js")), "/api/stream")
      const run = yield* json<WebRun>(yield* get("/api/run"))
      assert.strictEqual(run.mode, "replay")
      assert.strictEqual(run.trace, "trace-1790000000000.jsonl")
      assert.strictEqual(run.speed, 10)
      assert.strictEqual(run.steps.length, 50)
      assert.strictEqual(run.lastSeq, 50)
      const frame = yield* json<WebFrame>(yield* get("/api/frame?count=33"))
      assert.strictEqual(frame.seq, 33)
      assert.strictEqual(frame.title, "epic conto-bonifico")
      assert.strictEqual((yield* get("/api/frame?count=lots")).status, 400)
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
      const run = yield* json<WebRun>(yield* get("/api/run"))
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
