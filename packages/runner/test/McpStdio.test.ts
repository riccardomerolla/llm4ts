import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { InteractionShape } from "@llm4ts/flow/Interaction"
import { askUserTool } from "@llm4ts/flow/McpServer"
import { mcpStdioResponses } from "@llm4ts/runner/McpStdio"

const interaction: InteractionShape = {
  ask: (question) => Effect.succeed(`answer:${question}`)
}

describe("MCP stdio transport", () => {
  it.effect("emits one JSON line per request and nothing for notifications", () =>
    Effect.gen(function* () {
      const input = Stream.fromIterable([
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ask_user","arguments":{"question":"ship?"}}}'
      ])
      const output = yield* Stream.runCollect(mcpStdioResponses(input, [askUserTool(interaction)]))

      assert.strictEqual(output.length, 2)
      assert.isTrue(output.every((line) => line.startsWith("{")))
      assert.isTrue(output.every((line) => !line.includes("\n")))
      assert.match(output[1] ?? "", /answer:ship\?/)
    })
  )
})
