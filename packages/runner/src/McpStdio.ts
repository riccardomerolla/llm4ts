import { createInterface } from "node:readline"
import { stdin, stdout } from "node:process"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import { handleMcpLine, type McpTool } from "@llm4ts/flow/McpServer"

export const mcpStdioResponses = <R>(
  lines: Stream.Stream<string, FlowError, R>,
  tools: ReadonlyArray<McpTool>
): Stream.Stream<string, FlowError, R> =>
  lines.pipe(
    Stream.mapEffect((line) => handleMcpLine(line, tools)),
    Stream.filter((response): response is string => response !== undefined)
  )

export const runMcpStdio = (
  tools: ReadonlyArray<McpTool>,
  write: (line: string) => void = (line) => stdout.write(`${line}\n`)
): Effect.Effect<void, FlowError> =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      createInterface({
        input: stdin,
        crlfDelay: Infinity,
        terminal: false
      })
    ),
    (input) => {
      const lines = Stream.fromAsyncIterable(input, (error) =>
        ProcessError.make({
          message: "MCP stdio input",
          detail: error instanceof Error ? error.message : String(error)
        })
      )
      return mcpStdioResponses(lines, tools).pipe(
        Stream.runForEach((line) => Effect.sync(() => write(line)))
      )
    },
    (input) => Effect.sync(() => input.close())
  )
