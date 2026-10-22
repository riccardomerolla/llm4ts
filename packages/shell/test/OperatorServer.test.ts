import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import { Info, StageStarted, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { OperatorRun } from "@llm4ts/flow/OperatorSchemas"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { OperatorConfig } from "@llm4ts/shell/OperatorConfig"
import { httpAppLayer } from "@llm4ts/shell/OperatorServer"
import type { OperatorDeps } from "@llm4ts/shell/OperatorTools"

const t0 = 1_790_000_000_000
const repoPath = "/repo"
const tracePath = "/repo/.llm4ts/trace-1790000000000.jsonl"
const token = "s3cret-operator-token"
const endpoint = "http://localhost/mcp"

type HttpConfig = OperatorConfig & {
  readonly transport: {
    readonly _tag: "http"
    readonly host: string
    readonly port: number
    readonly token: string
  }
}

const configWith = (
  allow: { readonly run?: boolean; readonly approve?: boolean } = {}
): HttpConfig => ({
  transport: { _tag: "http", host: "127.0.0.1", port: 0, token },
  repos: [{ id: "app", path: repoPath }],
  allowRun: allow.run ?? false,
  allowApprove: allow.approve ?? false,
  parallelRuns: 1
})

const event = (seq: number, value: FlowEvent): TraceLine =>
  TraceLine.make({
    schemaVersion: 1,
    seq,
    timestamp: t0 + seq * 1_000,
    runId: "op-1",
    kind: value._tag,
    fields: { event: JSON.stringify(value) }
  })

const trace = [
  event(1, StageStarted.make({ stage: "story a", lane: "a" })),
  event(2, Info.make({ message: "gates: pnpm test" }))
]

const run = new OperatorRun({
  runId: "op-1",
  repo: "app",
  flow: "epic-stories",
  args: [],
  knobs: {},
  startedAt: t0,
  pid: 4242,
  tracePath,
  logDir: "/state/llm4ts/mcp/app/runs/op-1",
  state: "running"
})

const depsFor = (config: OperatorConfig) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore({
      [tracePath]: trace.map((line) => JSON.stringify(line)).join("\n") + "\n"
    })
    const deps: OperatorDeps = {
      config,
      files: memory.store,
      listFiles: () => [],
      listTraces: (directory) => (directory === "/repo/.llm4ts" ? [tracePath] : []),
      listEpics: () => [],
      transcripts: { read: () => Effect.succeed(undefined), list: () => [] },
      supervisor: {
        start: () => Effect.die("unused"),
        stop: () => Effect.die("unused"),
        get: (runId) => Effect.succeed(runId === run.runId ? run : undefined),
        list: () => Effect.succeed([run])
      },
      doctor: Effect.die("unused"),
      roster: () => Effect.die("unused"),
      probe: () => Effect.succeed(false),
      flows: () => Effect.succeed([]),
      now: Effect.succeed(t0 + 60_000),
      environment: {}
    }
    return deps
  })

const JsonRpcReply = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
})
const ToolsList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
const ToolsCall = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.Struct({ summary: Schema.String })
})

const harness = (config: HttpConfig) =>
  Effect.gen(function* () {
    const deps = yield* depsFor(config)
    const { dispose, handler } = HttpRouter.toWebHandler(httpAppLayer(config, deps), {
      disableLogger: true
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    let sessionId: string | null = null
    let nextId = 0
    const post = (body: unknown, headers: Readonly<Record<string, string>> = {}) =>
      Effect.promise(() =>
        handler(
          new Request(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              ...(sessionId === null
                ? {}
                : { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }),
              ...headers
            },
            body: JSON.stringify(body)
          })
        )
      )
    const authorized = { authorization: `Bearer ${token}` }
    const rpc = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const response = yield* post({ jsonrpc: "2.0", id: ++nextId, method, params }, authorized)
        assert.strictEqual(response.status, 200)
        sessionId = response.headers.get("mcp-session-id") ?? sessionId
        const reply = yield* Schema.decodeUnknownEffect(JsonRpcReply)(
          yield* Effect.promise(() => response.json())
        )
        assert.isUndefined(reply.error)
        return reply.result
      })
    const initialize = rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "TestClient", version: "1.0.0" }
    })
    const toolNames = Effect.gen(function* () {
      yield* initialize
      const listed = yield* Schema.decodeUnknownEffect(ToolsList)(yield* rpc("tools/list", {}))
      return listed.tools.map((tool) => tool.name)
    })
    return { post, rpc, initialize, toolNames }
  })

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "TestClient", version: "1.0.0" }
  }
}

describe("OperatorServer", () => {
  it.effect("no token is 401", () =>
    Effect.gen(function* () {
      const { post } = yield* harness(configWith())
      const response = yield* post(initializeBody)
      assert.strictEqual(response.status, 401)
      assert.strictEqual(yield* Effect.promise(() => response.text()), "")
    })
  )

  it.effect("a token of another length is 401, not an error", () =>
    Effect.gen(function* () {
      const { post } = yield* harness(configWith())
      const shorter = yield* post(initializeBody, { authorization: "Bearer s3cret" })
      assert.strictEqual(shorter.status, 401)
      const longer = yield* post(initializeBody, { authorization: `Bearer ${token}-and-more` })
      assert.strictEqual(longer.status, 401)
      const sameLength = yield* post(initializeBody, {
        authorization: `Bearer ${"x".repeat(token.length)}`
      })
      assert.strictEqual(sameLength.status, 401)
      const wrongScheme = yield* post(initializeBody, { authorization: `Basic ${token}` })
      assert.strictEqual(wrongScheme.status, 401)
    })
  )

  it.effect("the right token initializes and lists only read tools", () =>
    Effect.gen(function* () {
      const { toolNames } = yield* harness(configWith())
      const names = yield* toolNames
      assert.include(names, "preflight")
      assert.include(names, "run_status")
      assert.include(names, "run_wait")
      for (const act of ["start_run", "stop_run", "retro_start", "approve"]) {
        assert.notInclude(names, act)
      }
    })
  )

  it.effect("--allow-run lists start_run and stop_run but not approve", () =>
    Effect.gen(function* () {
      const { toolNames } = yield* harness(configWith({ run: true }))
      const names = yield* toolNames
      assert.include(names, "start_run")
      assert.include(names, "stop_run")
      assert.include(names, "retro_start")
      assert.include(names, "preflight")
      assert.notInclude(names, "approve")
    })
  )

  it.effect("--allow-approve lists approve", () =>
    Effect.gen(function* () {
      const { toolNames } = yield* harness(configWith({ approve: true }))
      const names = yield* toolNames
      assert.include(names, "approve")
      assert.notInclude(names, "start_run")
      assert.notInclude(names, "stop_run")
    })
  )

  it.effect("tools/call run_status answers structured content", () =>
    Effect.gen(function* () {
      const { initialize, rpc } = yield* harness(configWith())
      yield* initialize
      const result = yield* Schema.decodeUnknownEffect(ToolsCall)(
        yield* rpc("tools/call", { name: "run_status", arguments: { runId: "op-1" } })
      )
      assert.notStrictEqual(result.isError, true)
      assert.isString(result.structuredContent.summary)
    })
  )
})
