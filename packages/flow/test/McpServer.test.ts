import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { askUserTool, handleMcpLine, handleMcpRequest } from "@llm4ts/flow/McpServer"
import type { InteractionShape } from "@llm4ts/flow/Interaction"

const echo: InteractionShape = {
  ask: (question) => Effect.succeed(`you said: ${question}`)
}

const failing: InteractionShape = {
  ask: (_question) => Effect.fail(FlowAborted.make({ message: "no human available" }))
}

describe("MCP JSON-RPC handler", () => {
  it.effect("negotiates initialize and advertises tools", () =>
    Effect.gen(function* () {
      const tools = [askUserTool(echo)]
      const initialized = yield* handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" }
        },
        tools
      )
      const listed = yield* handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        },
        tools
      )
      const initializeJson = JSON.stringify(initialized)
      const listJson = JSON.stringify(listed)

      assert.match(initializeJson, /2025-03-26/)
      assert.match(initializeJson, /llm4ts/)
      assert.match(listJson, /ask_user/)
      assert.match(listJson, /inputSchema/)
    })
  )

  it.effect("bridges tool calls and turns failures into isError results", () =>
    Effect.gen(function* () {
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: { question: "deploy?" }
        }
      }
      const success = yield* handleMcpRequest(request, [askUserTool(echo)])
      const failure = yield* handleMcpRequest(request, [askUserTool(failing)])

      assert.match(JSON.stringify(success), /you said: deploy\?/)
      assert.match(JSON.stringify(success), /"isError":false/)
      assert.match(JSON.stringify(failure), /no human available/)
      assert.match(JSON.stringify(failure), /"isError":true/)
    })
  )

  it.effect("suppresses notifications and returns standard protocol errors", () =>
    Effect.gen(function* () {
      const notification = yield* handleMcpRequest(
        {
          jsonrpc: "2.0",
          method: "notifications/initialized"
        },
        []
      )
      const unknown = yield* handleMcpLine('{"jsonrpc":"2.0","id":1,"method":"unknown"}', [])
      const malformed = yield* handleMcpLine("{bad", [])

      assert.strictEqual(notification, undefined)
      assert.match(unknown ?? "", /-32601/)
      assert.match(malformed ?? "", /-32700/)
    })
  )
})
