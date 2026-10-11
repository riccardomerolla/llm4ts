import {
  isJsonRecord,
  jsonArray,
  jsonField,
  jsonStringField,
  jsonText,
  parseJsonLine,
  type JsonRecord,
  type JsonValue
} from "./CliSupport.ts"

/**
 * Gemini CLI as a plain model for pi (ADR 0037): the pure half of the
 * bridge's `/v1/chat/completions` route. pi's OpenAI-shaped request becomes
 * a system file (pi's own system prompt, a text tool-call protocol and pi's
 * tool schemas) plus a transcript for one `gemini` call; Gemini's reply
 * becomes an OpenAI completion carrying either text or one tool call. The
 * runner owns the process and the HTTP; nothing here does I/O.
 */

export interface BridgeTool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonValue
}

/** One message of pi's request, as the transcript needs it. */
export type BridgeMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant"
      readonly text: string
      readonly toolCalls: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly arguments: string
      }>
    }
  | { readonly role: "tool"; readonly callId: string; readonly text: string }

export type ChatRequest =
  | {
      readonly _tag: "Request"
      readonly model: string
      readonly stream: boolean
      readonly system: string
      readonly tools: ReadonlyArray<BridgeTool>
      readonly messages: ReadonlyArray<BridgeMessage>
    }
  | { readonly _tag: "Invalid"; readonly reason: string }

/** A message's text: a string, or the text parts of a content list (images are named, not sent). */
const contentText = (content: JsonValue | undefined): string => {
  if (typeof content === "string") {
    return content
  }
  return jsonArray(content)
    .map((part) =>
      jsonStringField(part, "type") === "text"
        ? (jsonStringField(part, "text") ?? "")
        : `[${jsonStringField(part, "type") ?? "part"} omitted]`
    )
    .join("\n")
}

/** pi's OpenAI chat-completions body, read once at the boundary. */
export const chatRequestFrom = (body: JsonValue): ChatRequest => {
  const model = jsonStringField(body, "model")
  const raw = jsonField(body, "messages")
  if (model === undefined || !Array.isArray(raw)) {
    return { _tag: "Invalid", reason: "a chat request needs a model and a messages array" }
  }
  const system: Array<string> = []
  const messages: Array<BridgeMessage> = []
  for (const message of jsonArray(raw)) {
    const role = jsonStringField(message, "role")
    const text = contentText(jsonField(message, "content"))
    if (role === "system" || role === "developer") {
      system.push(text)
    } else if (role === "user") {
      messages.push({ role: "user", text })
    } else if (role === "assistant") {
      messages.push({
        role: "assistant",
        text,
        toolCalls: jsonArray(jsonField(message, "tool_calls")).map((call) => ({
          id: jsonStringField(call, "id") ?? "",
          name: jsonStringField(jsonField(call, "function"), "name") ?? "",
          arguments: jsonStringField(jsonField(call, "function"), "arguments") ?? "{}"
        }))
      })
    } else if (role === "tool") {
      messages.push({ role: "tool", callId: jsonStringField(message, "tool_call_id") ?? "", text })
    }
  }
  const tools = jsonArray(jsonField(body, "tools")).flatMap((tool): ReadonlyArray<BridgeTool> => {
    const fn = jsonField(tool, "function")
    const name = jsonStringField(fn, "name")
    return name === undefined
      ? []
      : [
          {
            name,
            description: jsonStringField(fn, "description") ?? "",
            parameters: jsonField(fn, "parameters") ?? {}
          }
        ]
  })
  return {
    _tag: "Request",
    model,
    stream: jsonField(body, "stream") === true,
    system: system.filter((part) => part.trim().length > 0).join("\n\n"),
    tools,
    messages
  }
}

/** The protocol the model answers in: one `<tool_call>` block, or plain text. */
export const toolCallProtocol = [
  "## Tools",
  "",
  "You cannot act yourself: you ask the caller to run a tool, and its result comes back as",
  "the next message. To call a tool, reply with exactly one block and nothing after it:",
  "",
  '<tool_call>{"name": "<tool>", "arguments": {...}}</tool_call>',
  "",
  "The arguments are a JSON object matching the tool's parameters. Call one tool at a time.",
  "When no tool is needed, reply in plain text without any <tool_call> block.",
  "Never call a native function, update_topic included: it does nothing here. Only the",
  "<tool_call> block reaches the caller."
].join("\n")

/**
 * The file `GEMINI_SYSTEM_MD` points at: pi's system prompt, the protocol,
 * every tool with its schema, and how the conversation is laid out. It
 * replaces Gemini CLI's own system prompt entirely.
 */
export const systemFileFor = (request: Extract<ChatRequest, { _tag: "Request" }>): string =>
  [
    request.system,
    toolCallProtocol,
    "",
    "Available tools:",
    ...request.tools.map(
      (tool) =>
        `- ${tool.name}: ${tool.description.trim()}\n  parameters (JSON Schema): ${jsonText(tool.parameters)}`
    ),
    "",
    "## The conversation",
    "",
    "The conversation so far is given as a transcript of [user], [assistant] and [tool result]",
    "sections, oldest first. Reply with your next assistant message only, without a section label."
  ]
    .filter((part) => part !== undefined)
    .join("\n")
    .trim()

/** Normalised JSON of a call's arguments, so past calls read like the protocol asks. */
const argumentsJson = (raw: string): string => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return JSON.stringify(parsed)
  } catch {
    return raw
  }
}

/** The conversation as the prompt of one `gemini` call. */
export const transcriptFor = (messages: ReadonlyArray<BridgeMessage>): string => {
  const names = new Map<string, string>()
  const sections = messages.map((message) => {
    switch (message.role) {
      case "user":
        return `[user]\n${message.text}`
      case "assistant": {
        const calls = message.toolCalls.map((call) => {
          names.set(call.id, call.name)
          return `<tool_call>{"name":${JSON.stringify(call.name)},"arguments":${argumentsJson(call.arguments)}}</tool_call>`
        })
        return `[assistant]\n${[message.text, ...calls].filter((part) => part.trim().length > 0).join("\n")}`
      }
      case "tool":
        return `[tool result for ${names.get(message.callId) ?? "a tool"} (${message.callId})]\n${message.text}`
    }
  })
  return `${sections.join("\n\n")}\n`
}

export type ModelReply =
  | { readonly _tag: "Text"; readonly text: string }
  | {
      readonly _tag: "ToolCall"
      /** Whatever the model wrote before the block. */
      readonly text: string
      readonly name: string
      readonly arguments: JsonRecord
    }
  | { readonly _tag: "Malformed"; readonly text: string; readonly error: string }

/** Gemini's reply as text, one tool call, or a block that is not a valid call. */
export const parseModelReply = (reply: string, toolNames: ReadonlyArray<string>): ModelReply => {
  const opened = reply.indexOf("<tool_call>")
  if (opened < 0) {
    return { _tag: "Text", text: reply.trim() }
  }
  const before = reply.slice(0, opened).trim()
  const closed = reply.indexOf("</tool_call>", opened)
  if (closed < 0) {
    return { _tag: "Malformed", text: reply, error: "the <tool_call> block is not closed" }
  }
  const json = parseJsonLine(reply.slice(opened + "<tool_call>".length, closed).trim())
  if (json === undefined || !isJsonRecord(json)) {
    return { _tag: "Malformed", text: reply, error: "the block is not a valid JSON object" }
  }
  const name = jsonStringField(json, "name")
  if (name === undefined || !toolNames.includes(name)) {
    return {
      _tag: "Malformed",
      text: reply,
      error: `"${name ?? "(no name)"}" is not one of the available tools (${toolNames.join(", ")})`
    }
  }
  const args = jsonField(json, "arguments") ?? {}
  return isJsonRecord(args)
    ? { _tag: "ToolCall", text: before, name, arguments: args }
    : { _tag: "Malformed", text: reply, error: "arguments is not a JSON object" }
}

/** The one retry after a malformed call: the model sees its reply and why it failed. */
export const correctionTranscript = (transcript: string, reply: string, error: string): string =>
  [
    transcript.trimEnd(),
    "",
    `[assistant]\n${reply.trim()}`,
    "",
    `[user]\nYour last reply could not be used: ${error}. Reply again with exactly one valid <tool_call> block, or with plain text if no tool is needed.`,
    ""
  ].join("\n")

/** Gemini CLI's stats as llm4ts reads them: input is the uncached prompt. */
export interface GeminiTokens {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cached?: number
}

export interface OpenAiUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
  readonly prompt_tokens_details: { readonly cached_tokens: number }
}

/** OpenAI's usage: the prompt includes cached tokens, which are also reported apart. */
export const openAiUsage = (tokens: GeminiTokens | undefined): OpenAiUsage => {
  const cached = tokens?.cached ?? 0
  const prompt = (tokens?.inputTokens ?? 0) + cached
  const completion = tokens?.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached }
  }
}

const usageJson = (usage: OpenAiUsage): JsonRecord => ({
  prompt_tokens: usage.prompt_tokens,
  completion_tokens: usage.completion_tokens,
  total_tokens: usage.total_tokens,
  prompt_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens }
})

const replyText = (reply: ModelReply): string => reply.text

const toolCallJson = (reply: ModelReply, callId: string): ReadonlyArray<JsonRecord> =>
  reply._tag === "ToolCall"
    ? [
        {
          id: callId,
          type: "function",
          function: { name: reply.name, arguments: JSON.stringify(reply.arguments) }
        }
      ]
    : []

/** A non-streaming completion. A malformed reply that survived the retry goes back as text. */
export const completionJson = (
  id: string,
  model: string,
  reply: ModelReply,
  usage: OpenAiUsage,
  created: number,
  callId: string
): JsonRecord => {
  const calls = toolCallJson(reply, callId)
  const text = replyText(reply)
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length === 0 ? null : text,
          ...(calls.length === 0 ? {} : { tool_calls: calls })
        },
        finish_reason: calls.length === 0 ? "stop" : "tool_calls"
      }
    ],
    usage: usageJson(usage)
  }
}

/**
 * The same completion as stream chunks: the role, the text, the tool call,
 * the finish reason, then the usage (`stream_options.include_usage`'s
 * shape). The reply is whole before the first chunk: Gemini CLI runs to
 * its end before the bridge parses it.
 */
export const completionChunks = (
  id: string,
  model: string,
  reply: ModelReply,
  usage: OpenAiUsage,
  created: number,
  callId: string
): ReadonlyArray<JsonRecord> => {
  const chunk = (delta: JsonRecord, finish: string | null): JsonRecord => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const text = replyText(reply)
  const calls = toolCallJson(reply, callId)
  return [
    chunk({ role: "assistant", content: "" }, null),
    ...(text.length === 0 ? [] : [chunk({ content: text }, null)]),
    ...calls.map((call, index) => chunk({ tool_calls: [{ index, ...call }] }, null)),
    chunk({}, calls.length === 0 ? "stop" : "tool_calls"),
    { id, object: "chat.completion.chunk", created, model, choices: [], usage: usageJson(usage) }
  ]
}

/**
 * The one built-in tool left in the model's view. Gemini CLI always sends
 * `tools: [{ functionDeclarations }]`, and with none declared Google
 * rejects the request (`tools[0].tool_type: required one_of`). This one
 * only sets a status line: no file, shell or network access.
 */
export const inertGeminiTool = "update_topic"

/**
 * The admin policy for a model-mode call: every tool denied — a deny rule
 * without an argument pattern excludes the tool from the model's view, and
 * `*` matches every tool, sub-agents included — except the one inert tool,
 * allowed at a higher priority so the tool list is never empty (ADR 0037).
 */
export const modelModePolicyToml = [
  "[[rule]]",
  'toolName = "*"',
  'decision = "deny"',
  "priority = 100",
  "",
  "[[rule]]",
  `toolName = "${inertGeminiTool}"`,
  'decision = "allow"',
  "priority = 999",
  ""
].join("\n")

/** Gemini CLI's system settings for a model-mode call: no sub-agents. */
export const modelModeSettingsJson = JSON.stringify({ experimental: { enableAgents: false } })
