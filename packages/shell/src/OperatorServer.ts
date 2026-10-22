import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import type * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as Toolkit from "effect/ai/Toolkit"
import * as HttpRouter from "effect/http/HttpRouter"
import type { ServeError } from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import {
  actHandlers,
  actToolkit,
  approveTool,
  retroStartTool,
  startRunTool,
  stopRunTool,
  waitHandlers,
  waitToolkit
} from "./OperatorActTools.ts"
import type { OperatorConfig } from "./OperatorConfig.ts"
import { readHandlers, readToolkit, type OperatorDeps } from "./OperatorTools.ts"
import { packageVersion } from "./Package.ts"

/**
 * The operator MCP server (`llm4ts mcp`, ADR 0041): the read, wait and allowed
 * act tools served over stdio, or over HTTP at `/mcp` behind a bearer token.
 * A tool that the configuration does not allow is never registered, so it is
 * absent from `tools/list` rather than refused when called.
 */

export const serverName = "llm4ts"
export const serverPath = "/mcp"

type HttpTransport = Extract<OperatorConfig["transport"], { readonly _tag: "http" }>
export type HttpOperatorConfig = OperatorConfig & { readonly transport: HttpTransport }

const serverInfo = {
  name: serverName,
  version: packageVersion,
  protocols: [McpProtocol.v2025_06_18]
} as const

const runToolkit = Toolkit.make(startRunTool, stopRunTool, retroStartTool)
const approveToolkit = Toolkit.make(approveTool)

/** The act tools a configuration allows: `--allow-run` and `--allow-approve` each add their own. */
export const actToolkitFor = (config: OperatorConfig) =>
  config.allowRun
    ? config.allowApprove
      ? actToolkit
      : runToolkit
    : config.allowApprove
      ? approveToolkit
      : Toolkit.empty

const actLayer = (config: OperatorConfig, deps: OperatorDeps): Layer.Layer<never> => {
  const act = actHandlers(deps)
  if (config.allowRun && config.allowApprove) {
    return McpServer.toolkit(actToolkit).pipe(Layer.provide(actToolkit.toLayer(act)))
  }
  if (config.allowRun) {
    const handlers = runToolkit.of({
      start_run: act.start_run,
      stop_run: act.stop_run,
      retro_start: act.retro_start
    })
    return McpServer.toolkit(runToolkit).pipe(Layer.provide(runToolkit.toLayer(handlers)))
  }
  if (config.allowApprove) {
    const handlers = approveToolkit.of({ approve: act.approve })
    return McpServer.toolkit(approveToolkit).pipe(Layer.provide(approveToolkit.toLayer(handlers)))
  }
  return Layer.empty
}

/** Every tool this configuration serves, registered on the server it is provided. */
export const toolLayer = (
  config: OperatorConfig,
  deps: OperatorDeps
): Layer.Layer<never, never, McpServer.McpServer> =>
  Layer.mergeAll(
    McpServer.toolkit(readToolkit).pipe(Layer.provide(readToolkit.toLayer(readHandlers(deps)))),
    McpServer.toolkit(waitToolkit).pipe(Layer.provide(waitToolkit.toLayer(waitHandlers(deps)))),
    actLayer(config, deps)
  )

const unauthorized = HttpServerResponse.empty({ status: 401 })

/**
 * Lets a request through only with `Authorization: Bearer <token>`, compared in
 * constant time; anything else is a bare 401. The token is never logged.
 */
export const bearerMiddleware = (token: string): Layer.Layer<never> => {
  const expected = Buffer.from(`Bearer ${token}`, "utf8")
  const matches = (header: string | undefined): boolean => {
    if (header === undefined) return false
    const actual = Buffer.from(header, "utf8")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  return HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return matches(request.headers.authorization) ? yield* httpEffect : unauthorized
    })
  ).layer
}

/** The HTTP application: the tools on an MCP endpoint at `/mcp`, behind the bearer token. */
export const httpAppLayer = (
  config: HttpOperatorConfig,
  deps: OperatorDeps
): Layer.Layer<never, Cause.IllegalArgumentError, HttpRouter.HttpRouter> =>
  toolLayer(config, deps).pipe(
    Layer.provide(McpServer.layerHttp({ ...serverInfo, path: serverPath })),
    Layer.provide(bearerMiddleware(config.transport.token))
  )

const RpcCall = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) }))
})
const decodeRpcCall = Schema.decodeUnknownOption(Schema.fromJsonString(RpcCall))

/** What a request asked for: its JSON-RPC method and, for `tools/call`, the tool. Never its arguments. */
const requestLabel = (body: string): string =>
  Option.match(decodeRpcCall(body), {
    onNone: () => "request",
    onSome: (call) =>
      call.method === "tools/call" && call.params?.name !== undefined
        ? `tools/call ${call.params.name}`
        : call.method
  })

/**
 * One log line per HTTP request: method, tool, duration and status. The body
 * is read only after the endpoint has read it (the read is cached), and never
 * for a request the token check turned away.
 */
const requestLog = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const response = yield* httpEffect
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt
      const label =
        response.status === 401 || request.method !== "POST"
          ? request.method
          : yield* request.text.pipe(
              Effect.map(requestLabel),
              Effect.orElseSucceed(() => "request")
            )
      yield* Effect.logInfo(`mcp ${label} ${elapsed}ms status=${response.status}`)
      return response
    }),
  { global: true }
)

/** Serves the operator tools on the configured transport until interrupted. */
export const runOperatorServer = (
  config: OperatorConfig,
  deps: OperatorDeps
): Effect.Effect<never, ServeError | Cause.IllegalArgumentError> => {
  const transport = config.transport
  if (transport._tag === "stdio") {
    // stdout carries the protocol: every log line goes to stderr.
    return Layer.launch(
      toolLayer(config, deps).pipe(
        Layer.provide(McpServer.layerStdio(serverInfo)),
        Layer.provide(NodeStdio.layer)
      )
    ).pipe(Effect.provideService(Logger.LogToStderr, true))
  }
  return Layer.launch(
    HttpRouter.serve(Layer.merge(httpAppLayer({ ...config, transport }, deps), requestLog), {
      disableLogger: true
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, { host: transport.host, port: transport.port })
      )
    )
  )
}
