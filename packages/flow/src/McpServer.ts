import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "./FlowError.ts"
import { ApprovalAllowed, type ApprovalPolicy, type InteractionShape } from "./Interaction.ts"

export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Json
  readonly call: (arguments_: Schema.Json) => Effect.Effect<string, FlowError>
}

export const McpProtocolVersion = "2025-06-18"
export const McpServerName = "llm4ts"
export const McpServerVersion = "1.0"

const objectField = (value: Schema.Json, name: string): Schema.Json | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }
  const field = Reflect.get(value, name)
  return Schema.is(Schema.Json)(field) ? field : undefined
}

const stringField = (value: Schema.Json, name: string): string | undefined => {
  const field = objectField(value, name)
  return typeof field === "string" ? field : undefined
}

const params = (request: Schema.Json): Schema.Json => objectField(request, "params") ?? {}

const result = (id: Schema.Json, value: Schema.Json): Schema.Json => ({
  jsonrpc: "2.0",
  id,
  result: value
})

const error = (id: Schema.Json, code: number, message: string): Schema.Json => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
})

const toolContent = (text: string, isError: boolean): Schema.Json => ({
  content: [{ type: "text", text }],
  isError
})

export const askUserTool = (interaction: InteractionShape): McpTool => ({
  name: "ask_user",
  description:
    "Ask the human operator a question and wait for their answer. Use when a decision or clarification is required.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to put to the human operator."
      }
    },
    required: ["question"]
  },
  call: (arguments_) => interaction.ask(stringField(arguments_, "question") ?? "")
})

export const approvalTool = (policy: ApprovalPolicy): McpTool => ({
  name: "approve",
  description:
    "Decide whether the agent may run a pending tool call and return its permission verdict.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" }
    },
    required: ["tool_name"]
  },
  call: (arguments_) => {
    const input = objectField(arguments_, "input") ?? {}
    return policy
      .decide(stringField(arguments_, "tool_name") ?? "", input)
      .pipe(
        Effect.map((decision) =>
          JSON.stringify(
            decision instanceof ApprovalAllowed
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: decision.reason }
          )
        )
      )
  }
})

const initializeResult = (request: Schema.Json): Schema.Json => ({
  protocolVersion: stringField(params(request), "protocolVersion") ?? McpProtocolVersion,
  capabilities: { tools: {} },
  serverInfo: {
    name: McpServerName,
    version: McpServerVersion
  }
})

const toolsListResult = (tools: ReadonlyArray<McpTool>): Schema.Json => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
})

const toolsCall = (
  id: Schema.Json,
  request: Schema.Json,
  tools: ReadonlyArray<McpTool>
): Effect.Effect<Schema.Json> => {
  const requestParams = params(request)
  const name = stringField(requestParams, "name") ?? ""
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) {
    return Effect.succeed(error(id, -32602, `unknown tool: ${name}`))
  }
  return Effect.result(tool.call(objectField(requestParams, "arguments") ?? {})).pipe(
    Effect.map((outcome) =>
      outcome._tag === "Success"
        ? result(id, toolContent(outcome.success, false))
        : result(id, toolContent(`tool '${name}' failed: ${outcome.failure.message}`, true))
    )
  )
}

export const handleMcpRequest = Effect.fn("@llm4ts/flow/McpServer.handle")(function* (
  request: Schema.Json,
  tools: ReadonlyArray<McpTool>
): Effect.fn.Return<Schema.Json | undefined> {
  const id = objectField(request, "id")
  if (id === undefined) {
    return undefined
  }
  switch (stringField(request, "method") ?? "") {
    case "initialize":
      return result(id, initializeResult(request))
    case "tools/list":
      return result(id, toolsListResult(tools))
    case "tools/call":
      return yield* toolsCall(id, request, tools)
    default:
      return error(id, -32601, `method not found: ${stringField(request, "method") ?? ""}`)
  }
})

const parseError = (): Schema.Json => ({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32700, message: "Parse error" }
})

export const handleMcpLine = (
  line: string,
  tools: ReadonlyArray<McpTool>
): Effect.Effect<string | undefined> => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(line)
  if (parsed._tag === "None") {
    return Effect.succeed(JSON.stringify(parseError()))
  }
  return handleMcpRequest(parsed.value, tools).pipe(
    Effect.map((response) => (response === undefined ? undefined : JSON.stringify(response)))
  )
}
