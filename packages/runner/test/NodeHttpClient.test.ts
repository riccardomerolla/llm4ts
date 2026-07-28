import { createServer, type Server } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import { nodeHttpClient } from "@llm4ts/runner/NodeHttpClient"

interface RunningServer {
  readonly server: Server
  readonly baseUrl: string
}

const serverError = (message: string, cause?: unknown): ProviderError =>
  ProviderError.make({
    message,
    ...(cause === undefined ? {} : { cause })
  })

const startServer: Effect.Effect<RunningServer, ProviderError> = Effect.callback((resume) => {
  const server = createServer((request, response) => {
    const path = request.url

    if (path === "/ok") {
      response.writeHead(200, { "Content-Type": "text/plain" })
      response.end("ok")
      return
    }
    if (path === "/created") {
      response.writeHead(201, { "Content-Type": "text/plain" })
      response.end("created")
      return
    }
    if (path === "/post") {
      const chunks: Array<string> = []
      request.setEncoding("utf8")
      request.on("data", (chunk) => chunks.push(String(chunk)))
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            body: chunks.join(""),
            contentType: request.headers["content-type"]
          })
        )
      })
      return
    }
    if (path === "/bad") {
      response.writeHead(400)
      response.end("bad input")
      return
    }
    if (path === "/auth") {
      response.writeHead(401)
      response.end("denied")
      return
    }
    if (path === "/rate") {
      response.writeHead(429, { "Retry-After": "3" })
      response.end("later")
      return
    }
    if (path === "/error") {
      response.writeHead(503)
      response.end("unavailable")
      return
    }
    if (path === "/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache"
      })
      response.write("data: one\n")
      response.write("\n")
      response.write("data: [DONE]\n")
      response.write("data: two\n")
      response.end()
      return
    }

    response.writeHead(404)
    response.end("not found")
  })

  const onError = (cause: Error): void =>
    resume(Effect.fail(serverError("Failed to start test HTTP server", cause)))

  server.once("error", onError)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    const address = server.address()
    if (address === null || typeof address === "string") {
      resume(Effect.fail(serverError("Test HTTP server has no TCP address")))
      return
    }
    resume(
      Effect.succeed({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      })
    )
  })

  return Effect.sync(() => server.close())
})

const stopServer = ({ server }: RunningServer): Effect.Effect<void, ProviderError> =>
  Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void)
      return
    }
    server.close((cause) =>
      cause === undefined
        ? resume(Effect.void)
        : resume(Effect.fail(serverError("Failed to stop test HTTP server", cause)))
    )
  })

const timeout = Duration.seconds(5)
const headers: Readonly<Record<string, string>> = {}

describe("NodeHttpClient", () => {
  it.effect("supports GET, JSON POST, and generic 2xx responses", () =>
    Effect.acquireUseRelease(
      startServer,
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const get = yield* nodeHttpClient.get(`${baseUrl}/ok`, headers, timeout)
          const post = yield* nodeHttpClient.postJson(
            `${baseUrl}/post`,
            '{"name":"llm4ts"}',
            headers,
            timeout
          )
          const sent = yield* nodeHttpClient.send(
            "PUT",
            `${baseUrl}/created`,
            "content",
            headers,
            "text/plain",
            timeout
          )

          assert.strictEqual(get, "ok")
          assert.deepStrictEqual(JSON.parse(post), {
            body: '{"name":"llm4ts"}',
            contentType: "application/json"
          })
          assert.strictEqual(sent, "created")
        }),
      stopServer
    )
  )

  it.effect("maps HTTP status codes to the typed error model", () =>
    Effect.acquireUseRelease(
      startServer,
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const bad = yield* Effect.flip(nodeHttpClient.get(`${baseUrl}/bad`, headers, timeout))
          const auth = yield* Effect.flip(nodeHttpClient.get(`${baseUrl}/auth`, headers, timeout))
          const rate = yield* Effect.flip(nodeHttpClient.get(`${baseUrl}/rate`, headers, timeout))
          const provider = yield* Effect.flip(
            nodeHttpClient.get(`${baseUrl}/error`, headers, timeout)
          )

          assert.strictEqual(bad._tag, "InvalidRequestError")
          assert.match(bad.message, /bad input/)
          assert.strictEqual(auth._tag, "AuthenticationError")
          assert.strictEqual(rate._tag, "RateLimitError")
          if (rate._tag === "RateLimitError") {
            assert.strictEqual(Duration.toMillis(rate.retryAfter ?? Duration.zero), 3_000)
          }
          assert.strictEqual(provider._tag, "ProviderError")
          assert.match(provider.message, /503/)
        }),
      stopServer
    )
  )

  it.effect("decodes SSE data records and ignores the completion marker", () =>
    Effect.acquireUseRelease(
      startServer,
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const events = yield* Stream.runCollect(
            nodeHttpClient.postJsonStreamSSE(`${baseUrl}/stream`, "{}", headers, timeout)
          )

          assert.deepStrictEqual(events, ["one", "two"])
        }),
      stopServer
    )
  )

  it.effect("rejects invalid URLs before making a request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(nodeHttpClient.get("not a url", headers, timeout))

      assert.strictEqual(error._tag, "InvalidRequestError")
      assert.match(error.message, /Invalid URL/)
    })
  )

  it.effect("releases the HTTP server resource after use", () =>
    Effect.gen(function* () {
      const running = yield* Effect.acquireUseRelease(startServer, Effect.succeed, stopServer)

      assert.isFalse(running.server.listening)
    })
  )
})
