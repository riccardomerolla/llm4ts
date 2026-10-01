import { assert, describe, it } from "@effect/vitest"
import { parseClaudeCliStreamLine } from "@llm4ts/core/providers/ClaudeCliConnector"
import { parseCodexStreamLine } from "@llm4ts/core/providers/CodexConnector"
import { parsePiStreamLine } from "@llm4ts/core/providers/PiConnector"

const ends = (chunks: ReadonlyArray<{ readonly metadata: Readonly<Record<string, string>> }>) =>
  chunks.map((chunk) => [
    chunk.metadata.event,
    chunk.metadata.tool_id,
    chunk.metadata.tool_name,
    chunk.metadata.tool_failed
  ])

describe("tool start and end, per CLI", () => {
  it("claude: a tool_use block starts a tool and the user's tool_result ends it", () => {
    assert.deepStrictEqual(
      ends(
        parseClaudeCliStreamLine(
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}]}}'
        )
      ),
      [["tool_use", "tu1", "Bash", undefined]]
    )
    assert.deepStrictEqual(
      ends(
        parseClaudeCliStreamLine(
          '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"boom"}]}}'
        )
      ),
      [["tool_result", "tu1", undefined, "true"]]
    )
  })

  it("pi: tool_execution_start and tool_execution_end carry the call id", () => {
    assert.deepStrictEqual(
      ends(
        parsePiStreamLine(
          '{"type":"tool_execution_start","toolCallId":"p1","toolName":"bash","args":{"command":"ls"}}'
        )
      ),
      [["tool_use", "p1", "bash", undefined]]
    )
    assert.deepStrictEqual(
      ends(parsePiStreamLine('{"type":"tool_execution_end","toolCallId":"p1","isError":false}')),
      [["tool_result", "p1", undefined, undefined]]
    )
  })

  it("codex: a command starts at item.started and ends at item.completed, with its exit code", () => {
    assert.deepStrictEqual(
      ends(
        parseCodexStreamLine(
          '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"cargo test"}}'
        )
      ),
      [["tool_use", "i1", "Bash", undefined]]
    )
    assert.deepStrictEqual(
      ends(
        parseCodexStreamLine(
          '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"cargo test","exit_code":101}}'
        )
      ),
      [["tool_result", "i1", "Bash", "true"]]
    )
  })

  it("carries what the tool returned, for a transcript", () => {
    const output = (chunks: ReadonlyArray<{ readonly metadata: Readonly<Record<string, string>> }>) =>
      chunks.map((chunk) => chunk.metadata.tool_content)
    assert.deepStrictEqual(
      output(
        parseClaudeCliStreamLine(
          '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"3 passed"}]}]}}'
        )
      ),
      ["3 passed"]
    )
    assert.deepStrictEqual(
      output(
        parseCodexStreamLine(
          '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"cargo test","aggregated_output":"ok","exit_code":0}}'
        )
      ),
      ["ok"]
    )
    assert.deepStrictEqual(
      output(
        parsePiStreamLine(
          '{"type":"tool_execution_end","toolCallId":"p1","result":{"content":[{"type":"text","text":"README.md"}]},"isError":false}'
        )
      ),
      ["README.md"]
    )
  })
})
