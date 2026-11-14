// @internal: `llm4ts watch --web`, served by the shell's own CLI
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { basename } from "node:path"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as NetAddress from "effect/net/NetAddress"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { readTrace } from "@llm4ts/flow/Replay"
import { reduceTree } from "@llm4ts/runner/AgentTree"
import {
  pollInterval,
  replayGap,
  resolveTraceTarget,
  startingTree,
  type TraceSources,
  type WatchOptions,
  type WatchTarget,
  type WatchTargetMissing
} from "./Watch.ts"
import { WebFrame, WebFrameJson, WebRun } from "./WebFrame.ts"
import {
  advance,
  foldSteps,
  frameOf,
  stepsOfTrace,
  type WebFold,
  type WebStep
} from "./WebWatchView.ts"

/**
 * `llm4ts watch --web` (ADR 0051): the agent tree in a browser. The same
 * trace `watch` reads, folded by the same `reduceTree`, served on loopback
 * as a page and a stream of frames (server-sent events). A live run is
 * re-read every `pollInterval`; a replay steps on `replayGap`, sped up as
 * the page asks. The terminal `watch` is untouched: this runs only with
 * `--web`.
 */

export type WebWatchOptions = Pick<
  WatchOptions,
  "repo" | "trace" | "epic" | "replay" | "speed" | "idleAfterMs"
> & {
  /** Loopback by default; the page shows the run to whoever can reach it. */
  readonly host?: string
  /** A free port when omitted. */
  readonly port?: number
}

/**
 * The page's files, under `packages/shell/web/`. `pnpm build` writes
 * `app.js` (bundled from `web-src/`) and copies the Geist fonts and their
 * licence into `fonts/` (scripts/build-web.mjs).
 */
export const webAssets: ReadonlyArray<{
  readonly path: HttpRouter.PathInput
  readonly file: string
  readonly type: string
}> = [
  { path: "/", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/style.css", file: "style.css", type: "text/css; charset=utf-8" },
  { path: "/app.js", file: "app.js", type: "text/javascript; charset=utf-8" },
  { path: "/fonts/Geist-Variable.woff2", file: "fonts/Geist-Variable.woff2", type: "font/woff2" },
  {
    path: "/fonts/GeistMono-Variable.woff2",
    file: "fonts/GeistMono-Variable.woff2",
    type: "font/woff2"
  },
  { path: "/fonts/OFL.txt", file: "fonts/OFL.txt", type: "text/plain; charset=utf-8" }
]

/**
 * Everything the page loads comes from this server: its script, its
 * stylesheet, its fonts, its frames. Nothing inline, nothing remote.
 */
export const contentSecurityPolicy =
  "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

export interface WebWatchDependencies extends TraceSources {
  readonly write: (text: string) => Effect.Effect<void>
  /** A page file's bytes. */
  readonly asset: (file: string) => Uint8Array | undefined
  /** Completes when the reader detaches (Ctrl-C). */
  readonly detach: Effect.Effect<void>
}

const defaultSpeed = 10

/** What the page asks for: a frame after `count` steps, played at `speed`. */
const FrameQuery = Schema.Struct({
  count: Schema.optional(Schema.FiniteFromString),
  speed: Schema.optional(Schema.FiniteFromString)
})

interface Loaded {
  readonly runId: string | undefined
  readonly lastSeq: number | undefined
  readonly steps: ReadonlyArray<WebStep>
}

const encodeFrame = Schema.encodeSync(WebFrameJson)

/** One server-sent event; `data` is JSON on a single line. */
const sse = (event: string, data: string): string => `event: ${event}\ndata: ${data}\n\n`

const frameEvent = (frame: WebFrame): string => sse("frame", encodeFrame(frame))
const endEvent = sse("end", "{}")

/**
 * The `Host` values a request may carry: the loopback names of the port the
 * server listens on. Anything else is refused, so a page on another origin
 * cannot read the run by rebinding its own name to 127.0.0.1.
 */
export const allowedHosts = (port: number): ReadonlySet<string> =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])

const portOf = (address: NetAddress.SocketAddress): number | undefined =>
  "port" in address ? address.port : undefined

/** Refuses a foreign `Host` (403); stamps every answer as not to be sniffed or cached. */
const guard = HttpRouter.middleware(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const port = portOf(server.address)
    const allowed = port === undefined ? new Set<string>() : allowedHosts(port)
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const host = request.headers["host"]
        const response =
          host !== undefined && allowed.has(host.toLowerCase())
            ? yield* app
            : HttpServerResponse.text("forbidden host", { status: 403 })
        return HttpServerResponse.setHeaders(response, {
          "x-content-type-options": "nosniff",
          "cache-control": "no-store"
        })
      })
  }),
  { global: true }
)

/**
 * The routes: the page, `/api/run`, `/api/frame?count=` (a replay's scrub),
 * and `/api/stream?count=&speed=` (a replay playing, or a live run followed),
 * behind the `Host` guard. Needs the `HttpServer` it is served on, for the
 * port the guard allows.
 */
export const webWatchApp = Effect.fn("@llm4ts/shell/WebWatch.app")(function* (
  options: WebWatchOptions,
  dependencies: WebWatchDependencies
): Effect.fn.Return<
  Layer.Layer<never, never, HttpRouter.HttpRouter | HttpServer.HttpServer>,
  FlowError | WatchTargetMissing
> {
  const target: WatchTarget = yield* resolveTraceTarget(options, dependencies)
  const replay = options.replay === true
  const start = yield* startingTree(target, dependencies.files, options.idleAfterMs)
  const load = Effect.map(
    readTrace(dependencies.files, target.tracePath),
    (lines): Loaded => ({
      runId: lines[0]?.runId,
      lastSeq: lines.at(-1)?.seq,
      steps: stepsOfTrace(lines)
    })
  )
  // Read once up front, so a missing or unreadable trace fails before serving.
  yield* load
  const speedOf = (asked: number | undefined): number =>
    Math.max(1, asked ?? options.speed ?? defaultSpeed)

  /** A live frame: every step, the clock moved to now while the run goes on. */
  const liveFrame = (loaded: Loaded): Effect.Effect<WebFrame> =>
    Effect.gen(function* () {
      const fold = foldSteps(start, loaded.steps)
      const now = yield* Clock.currentTimeMillis
      const state =
        fold.state.ended === undefined
          ? reduceTree(fold.state, { _tag: "Tick", at: now })
          : fold.state
      return frameOf({ ...fold, state }, { steps: loaded.steps.length, lastSeq: loaded.lastSeq })
    })

  const replayFrame = (loaded: Loaded, count: number): WebFrame =>
    frameOf(foldSteps(start, loaded.steps.slice(0, count)), {
      steps: loaded.steps.length,
      lastSeq: loaded.lastSeq
    })

  /** A replay from `count` steps on: each next step after its gap, until the last. */
  const replayStream = (loaded: Loaded, count: number, speed: number): Stream.Stream<string> => {
    const { steps } = loaded
    const frame = (fold: WebFold, gapMs: number): string =>
      frameEvent(frameOf(fold, { steps: steps.length, lastSeq: loaded.lastSeq, gapMs }))
    const first = foldSteps(start, steps.slice(0, count))
    return Stream.make(frame(first, 0)).pipe(
      Stream.concat(
        Stream.unfold(first, (fold) => {
          const next = steps[fold.count]
          if (next === undefined) {
            return Effect.succeed(undefined)
          }
          const gap = replayGap(steps[fold.count - 1]?.at ?? next.at, next.at, speed)
          const advanced = advance(fold, next)
          return Effect.as(Effect.sleep(Duration.millis(gap)), [
            frame(advanced, gap),
            advanced
          ] as const)
        })
      ),
      Stream.concat(Stream.make(endEvent))
    )
  }

  /** A live run: the trace re-read now and every poll, until it says the run ended. */
  const liveStream: Stream.Stream<string, FlowError> = Stream.fromEffectSchedule(
    Effect.flatMap(load, liveFrame),
    Schedule.spaced(pollInterval)
  ).pipe(
    Stream.takeUntil((frame) => frame.ended !== undefined),
    Stream.map(frameEvent),
    Stream.concat(Stream.make(endEvent))
  )

  const query = HttpServerRequest.schemaSearchParams(FrameQuery)
  const failed = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.succeed(
      HttpServerResponse.text(
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : "bad request",
        { status: 400 }
      )
    )

  const pages = webAssets.map((asset) =>
    HttpRouter.route("GET", asset.path, () => {
      const bytes = dependencies.asset(asset.file)
      return Effect.succeed(
        bytes === undefined
          ? HttpServerResponse.text("missing", { status: 404 })
          : HttpServerResponse.uint8Array(bytes, {
              contentType: asset.type,
              headers:
                asset.path === "/" ? { "content-security-policy": contentSecurityPolicy } : {}
            })
      )
    })
  )
  // The page names no icon; this keeps the browser's own request quiet.
  const favicon = HttpRouter.route("GET", "/favicon.ico", () =>
    Effect.succeed(HttpServerResponse.empty({ status: 204 }))
  )

  const run = HttpRouter.route(
    "GET",
    "/api/run",
    Effect.gen(function* () {
      const loaded = yield* load
      return yield* HttpServerResponse.schemaJson(WebRun)({
        mode: replay ? "replay" : "live",
        runId: loaded.runId,
        trace: basename(target.tracePath),
        speed: speedOf(undefined),
        steps: loaded.steps.map((step) => ({ seq: step.seq, at: step.at })),
        lastSeq: loaded.lastSeq,
        timeline: foldSteps(start, loaded.steps).timeline
      })
    }).pipe(Effect.catch(failed))
  )

  const frame = HttpRouter.route(
    "GET",
    "/api/frame",
    Effect.gen(function* () {
      const asked = yield* query
      const loaded = yield* load
      const body =
        replay || asked.count !== undefined
          ? replayFrame(
              loaded,
              Math.min(loaded.steps.length, Math.max(1, asked.count ?? loaded.steps.length))
            )
          : yield* liveFrame(loaded)
      return yield* HttpServerResponse.schemaJson(WebFrame)(body)
    }).pipe(Effect.catch(failed))
  )

  const stream = HttpRouter.route(
    "GET",
    "/api/stream",
    Effect.gen(function* () {
      const asked = yield* query
      const loaded = yield* load
      const body: Stream.Stream<string, FlowError> = replay
        ? replayStream(
            loaded,
            Math.min(loaded.steps.length, Math.max(1, asked.count ?? 1)),
            speedOf(asked.speed)
          )
        : liveStream
      return HttpServerResponse.stream(Stream.encodeText(body), {
        contentType: "text/event-stream",
        headers: { connection: "keep-alive" }
      })
    }).pipe(Effect.catch(failed))
  )

  return Layer.mergeAll(HttpRouter.addAll([...pages, favicon, run, frame, stream]), guard)
})

/** Serves the page until the reader detaches; prints where to open it. */
export const runWebWatch = Effect.fn("@llm4ts/shell/WebWatch.run")(function* (
  options: WebWatchOptions,
  dependencies: WebWatchDependencies
): Effect.fn.Return<void, FlowError | WatchTargetMissing | ServeError> {
  const app = yield* webWatchApp(options, dependencies)
  const host = options.host ?? "127.0.0.1"
  const announce = Layer.effectDiscard(
    HttpServer.addressFormattedWith((address) =>
      dependencies.write(
        `llm4ts watch --web${options.replay === true ? " --replay" : ""} · open ${address}/\nCtrl-C stops the server and detaches.\n`
      )
    )
  )
  let server: Server | undefined
  const served = Layer.launch(
    Layer.mergeAll(
      HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }),
      announce
    ).pipe(
      Layer.provide(
        NodeHttpServer.layer(
          () => {
            server = createServer()
            return server
          },
          { host, port: options.port ?? 0 }
        )
      )
    )
  )
  // A page holds its event stream open while the run is live, and the browser
  // reopens it on the same keep-alive socket when it ends. A graceful close
  // waits for those sockets, so it would never finish: on detach the server
  // stops listening and drops every connection, then the layer shuts down.
  const detach = Effect.andThen(
    dependencies.detach,
    Effect.sync(() => {
      server?.close()
      server?.closeAllConnections()
    })
  )
  yield* Effect.raceFirst(served, detach)
  yield* dependencies.write("detached\n")
})

// ── node wiring ─────────────────────────────────────────────────────────────

const webDir = new URL("../web/", import.meta.url)

/** A page file from `packages/shell/web/`, next to `src/` and `dist/` alike. */
export const nodeWebAsset = (file: string): Uint8Array | undefined => {
  try {
    return readFileSync(new URL(file, webDir))
  } catch {
    return undefined
  }
}

/** Ctrl-C (or a SIGTERM): the server stops instead of the process dying under it. */
export const nodeDetach: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const stop = (): void => resume(Effect.void)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return Effect.sync(() => {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  })
})

export const nodeWebWatchDependencies = (sources: TraceSources): WebWatchDependencies => ({
  ...sources,
  write: (text) => Effect.sync(() => void process.stdout.write(text)),
  asset: nodeWebAsset,
  detach: nodeDetach
})
