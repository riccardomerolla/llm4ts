import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { mcpOptionsFrom, type McpFlags } from "@llm4ts/shell/OperatorConfig"

const none: McpFlags = {
  stdio: false,
  http: false,
  host: Option.none(),
  port: Option.none(),
  tokenFile: Option.none(),
  repo: [],
  allowRun: false,
  allowApprove: false,
  parallelRuns: Option.none()
}

const noFiles = (): Effect.Effect<string | undefined> => Effect.succeed(undefined)

describe("mcpOptionsFrom", () => {
  it.effect("stdio is the default and needs no token", () =>
    Effect.gen(function* () {
      const config = yield* mcpOptionsFrom({ ...none, repo: ["portal"] }, {}, "/work", noFiles)
      assert.deepStrictEqual(config.transport, { _tag: "stdio" })
      assert.strictEqual(config.parallelRuns, 1)
      assert.isFalse(config.allowRun)
    })
  )

  it.effect("http without a token is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mcpOptionsFrom({ ...none, http: true, repo: ["portal"] }, {}, "/work", noFiles)
      )
      assert.strictEqual(error.message, "--http needs a token: LLM4TS_MCP_TOKEN or --token-file")
    })
  )

  it.effect("http reads the token from the file and trims the newline", () =>
    Effect.gen(function* () {
      const config = yield* mcpOptionsFrom(
        { ...none, http: true, tokenFile: Option.some("tok"), repo: ["portal"] },
        {},
        "/work",
        (path) => Effect.succeed(path === "/work/tok" ? "s3cret\n" : undefined)
      )
      assert.deepStrictEqual(config.transport, {
        _tag: "http",
        host: "127.0.0.1",
        port: 4321,
        token: "s3cret"
      })
    })
  )

  it.effect("repos come from --repo flags with basename ids, else from mcp.json", () =>
    Effect.gen(function* () {
      const flagged = yield* mcpOptionsFrom(
        { ...none, repo: ["../portal", "/abs/core"] },
        {},
        "/work/x",
        noFiles
      )
      assert.deepStrictEqual(flagged.repos, [
        { id: "portal", path: "/work/portal" },
        { id: "core", path: "/abs/core" }
      ])
      const fromFile = yield* mcpOptionsFrom(none, { XDG_CONFIG_HOME: "/cfg" }, "/work", (path) =>
        Effect.succeed(
          path === "/cfg/llm4ts/mcp.json"
            ? JSON.stringify({ repos: [{ id: "a", path: "/r/a" }] })
            : undefined
        )
      )
      assert.deepStrictEqual(fromFile.repos, [{ id: "a", path: "/r/a" }])
      const missing = yield* Effect.flip(mcpOptionsFrom(none, {}, "/work", noFiles))
      assert.strictEqual(missing.message, "mcp needs --repo <path> or ~/.config/llm4ts/mcp.json")
      const duplicate = yield* Effect.flip(
        mcpOptionsFrom({ ...none, repo: ["/a/x", "/b/x"] }, {}, "/work", noFiles)
      )
      assert.include(duplicate.message, "x")
    })
  )

  it.effect("both transports is a usage error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mcpOptionsFrom({ ...none, stdio: true, http: true }, {}, "/work", noFiles)
      )
      assert.include(error.message, "--stdio")
    })
  )
})
