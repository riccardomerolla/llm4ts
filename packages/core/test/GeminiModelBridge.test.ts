import { assert, describe, it } from "@effect/vitest"
import {
  jsonArray,
  jsonField,
  jsonStringField,
  type JsonValue
} from "@llm4ts/core/providers/CliSupport"
import {
  chatRequestFrom,
  completionChunks,
  completionJson,
  correctionTranscript,
  modelModePolicyToml,
  modelModeSettingsJson,
  openAiUsage,
  parseModelReply,
  systemFileFor,
  toolCallProtocol,
  transcriptFor
} from "@llm4ts/core/providers/GeminiModelBridge"

const piRequest: JsonValue = {
  model: "gemini-3.8-flash",
  stream: true,
  messages: [
    { role: "system", content: "You are pi, a coding agent." },
    { role: "user", content: [{ type: "text", text: "Show me package.json" }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"package.json"}' }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: '{"name":"demo"}' },
    { role: "user", content: "Now run the tests." }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } }
      }
    }
  ]
}

describe("Gemini model bridge (ADR 0037)", () => {
  it("reads pi's chat request: model, system, tools, stream", () => {
    const request = chatRequestFrom(piRequest)
    assert.strictEqual(request._tag, "Request")
    if (request._tag !== "Request") return
    assert.strictEqual(request.model, "gemini-3.8-flash")
    assert.isTrue(request.stream)
    assert.strictEqual(request.system, "You are pi, a coding agent.")
    assert.deepStrictEqual(
      request.tools.map((tool) => tool.name),
      ["read", "bash"]
    )
    assert.strictEqual(chatRequestFrom({ model: "x" })._tag, "Invalid")
  })

  it("writes the system file: pi's prompt, the tool-call protocol and every tool's schema", () => {
    const request = chatRequestFrom(piRequest)
    if (request._tag !== "Request") return assert.fail("not a request")
    const system = systemFileFor(request)
    assert.include(system, "You are pi, a coding agent.")
    assert.include(system, '<tool_call>{"name": "<tool>", "arguments": {...}}</tool_call>')
    assert.include(system, "- read: Read a file")
    assert.include(system, '"path":{"type":"string"}')
    assert.include(system, "- bash: Run a shell command")
  })

  it("renders the conversation with past tool calls in the protocol's own form", () => {
    const request = chatRequestFrom(piRequest)
    if (request._tag !== "Request") return assert.fail("not a request")
    const transcript = transcriptFor(request.messages)
    assert.include(transcript, "[user]\nShow me package.json")
    assert.include(
      transcript,
      '[assistant]\n<tool_call>{"name":"read","arguments":{"path":"package.json"}}</tool_call>'
    )
    assert.include(transcript, '[tool result for read (call_1)]\n{"name":"demo"}')
    assert.isTrue(transcript.trimEnd().endsWith("[user]\nNow run the tests."))
    assert.notInclude(transcript, "You are pi")
  })

  it("parses a reply into a tool call, plain text, or a malformed call", () => {
    const tools = ["read", "bash"]
    const call = parseModelReply(
      'I will run them.\n<tool_call>{"name": "bash", "arguments": {"command": "pnpm test"}}</tool_call>',
      tools
    )
    assert.deepStrictEqual(call, {
      _tag: "ToolCall",
      text: "I will run them.",
      name: "bash",
      arguments: { command: "pnpm test" }
    })
    assert.deepStrictEqual(parseModelReply("All done.", tools), { _tag: "Text", text: "All done." })
    const unknown = parseModelReply(
      '<tool_call>{"name": "glob", "arguments": {}}</tool_call>',
      tools
    )
    assert.strictEqual(unknown._tag, "Malformed")
    const broken = parseModelReply('<tool_call>{"name": "read", "arguments": </tool_call>', tools)
    assert.strictEqual(broken._tag, "Malformed")
    const unclosed = parseModelReply('<tool_call>{"name": "read"', tools)
    assert.strictEqual(unclosed._tag, "Malformed")
  })

  it("asks again once, showing the model its malformed reply and why", () => {
    const again = correctionTranscript("[user]\nhi", "<tool_call>{oops</tool_call>", "invalid JSON")
    assert.include(again, "[user]\nhi")
    assert.include(again, "[assistant]\n<tool_call>{oops</tool_call>")
    assert.include(again, "invalid JSON")
    assert.include(again, "exactly one valid <tool_call> block")
  })

  it("reports usage the OpenAI way: prompt includes cached, cached apart", () => {
    assert.deepStrictEqual(openAiUsage({ inputTokens: 1000, cached: 800, outputTokens: 50 }), {
      prompt_tokens: 1800,
      completion_tokens: 50,
      total_tokens: 1850,
      prompt_tokens_details: { cached_tokens: 800 }
    })
    assert.deepStrictEqual(openAiUsage(undefined), {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 }
    })
  })

  it("answers a tool call as an OpenAI completion and as chunks", () => {
    const reply = parseModelReply(
      '<tool_call>{"name": "read", "arguments": {"path": "a.ts"}}</tool_call>',
      ["read"]
    )
    const usage = openAiUsage({ inputTokens: 10, outputTokens: 5 })
    const json = completionJson("chatcmpl-1", "gemini-3.8-flash", reply, usage, 1, "call_7")
    const choice = jsonArray(jsonField(json, "choices"))[0]
    assert.strictEqual(jsonStringField(choice, "finish_reason"), "tool_calls")
    const toolCall = jsonArray(jsonField(jsonField(choice, "message"), "tool_calls"))[0]
    assert.strictEqual(jsonStringField(toolCall, "id"), "call_7")
    assert.strictEqual(
      jsonStringField(jsonField(toolCall, "function"), "arguments"),
      '{"path":"a.ts"}'
    )
    const chunks = completionChunks("chatcmpl-1", "gemini-3.8-flash", reply, usage, 1, "call_7")
    const last = chunks.at(-1)
    assert.strictEqual(jsonField(jsonField(last, "usage"), "prompt_tokens"), 10)
    assert.strictEqual(jsonField(jsonField(last, "usage"), "completion_tokens"), 5)
    const finish = chunks
      .map((chunk) => jsonStringField(jsonArray(jsonField(chunk, "choices"))[0], "finish_reason"))
      .filter((reason) => reason !== undefined)
    assert.deepStrictEqual(finish, ["tool_calls"])
    const text = completionChunks(
      "chatcmpl-2",
      "m",
      parseModelReply("hello", []),
      usage,
      1,
      "call_8"
    )
    const delta = jsonField(jsonArray(jsonField(text[1], "choices"))[0], "delta")
    assert.strictEqual(jsonStringField(delta, "content"), "hello")
  })

  it("locks Gemini CLI down to one inert tool: an empty tool list is a 400 from Google", () => {
    // Gemini CLI always sends tools: [{ functionDeclarations }]; with none
    // declared, the API rejects the request (tools[0].tool_type).
    assert.include(modelModePolicyToml, 'toolName = "*"')
    assert.include(modelModePolicyToml, 'decision = "deny"')
    assert.include(modelModePolicyToml, 'toolName = "update_topic"')
    assert.include(modelModePolicyToml, 'decision = "allow"')
    assert.notInclude(modelModePolicyToml, "argsPattern")
    const deny = /toolName = "\*"\ndecision = "deny"\npriority = (\d+)/u.exec(modelModePolicyToml)
    const allow = /toolName = "update_topic"\ndecision = "allow"\npriority = (\d+)/u.exec(
      modelModePolicyToml
    )
    assert.isAbove(Number(allow?.[1]), Number(deny?.[1]))
    assert.deepStrictEqual(JSON.parse(modelModeSettingsJson), {
      experimental: { enableAgents: false }
    })
  })

  it("tells the model its one native function is not for use", () => {
    assert.include(toolCallProtocol, "update_topic")
  })
})
