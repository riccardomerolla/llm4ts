#!/usr/bin/env node
/**
 * Diagnostic-only. Not part of any bridge, not part of `pnpm test`.
 *
 * Answers the open questions of ADR 0037 (Gemini CLI as a plain model for
 * pi) against a real, logged-in `gemini`, before any bridge code is written:
 *
 *   1. Does `GEMINI_SYSTEM_MD` replace the built-in system prompt in
 *      headless mode (`gemini -p`)? A canary planted in our prompt file must
 *      come back, and the prompt tokens must drop.
 *   2. Do `tools.core: []` and `experimental.enableAgents: false` (a system
 *      defaults file, as llm4ts injects one) remove every tool? Asked to run
 *      a shell command, Gemini must make no tool call, and the prompt tokens
 *      must drop further.
 *   3. How reliably does the model keep to a text tool-call protocol
 *      (`<tool_call>{"name":…,"arguments":{…}}</tool_call>`) for pi's tools?
 *   4. Does the override also apply in ACP mode (`gemini --experimental-acp`),
 *      the mode ADR 0016's bridge uses?
 *
 * Only `gemini` talks to Google, under its own login. This script never
 * reads ~/.gemini or any credential; it runs every call in a fresh empty
 * directory so no project GEMINI.md is loaded (a user-level
 * ~/.gemini/GEMINI.md still is: the report says so when the prompt tokens
 * stay high). Each stage is one model call against the subscription quota.
 *
 * Usage: node examples/gemini-model-probe.mjs [--model <id>] [--trials <n>] [--skip-acp]
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

const { console, process, setTimeout, clearTimeout } = globalThis

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const model = option("model")
const trials = Math.max(1, Number.parseInt(option("trials") ?? "5", 10) || 5)
const skipAcp = args.includes("--skip-acp")
const callTimeoutMs = 180_000

const work = mkdtempSync(join(tmpdir(), "llm4ts-gemini-model-probe-"))
const canary = `CANARY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

const plainPrompt = join(work, "plain-system.md")
writeFileSync(
  plainPrompt,
  [
    "You are a language model answering one request. You have no tools.",
    `If you are asked for the canary, reply with exactly ${canary} and nothing else.`
  ].join("\n")
)

const piTools = [
  { name: "read", description: "Read a file", parameters: { path: "string" } },
  { name: "bash", description: "Run a shell command", parameters: { command: "string" } },
  {
    name: "edit",
    description: "Replace text in a file",
    parameters: { path: "string", oldText: "string", newText: "string" }
  },
  { name: "write", description: "Write a file", parameters: { path: "string", content: "string" } }
]
const protocolPrompt = join(work, "protocol-system.md")
writeFileSync(
  protocolPrompt,
  [
    "You are a coding agent's model. You cannot act yourself: you ask the caller to run a tool.",
    "To call a tool, reply with exactly one block and nothing after it:",
    '<tool_call>{"name": "<tool>", "arguments": {...}}</tool_call>',
    "The arguments are a JSON object with the parameters the tool lists. When no tool is",
    "needed, reply in plain text without any <tool_call> block.",
    "",
    "Tools:",
    ...piTools.map(
      (tool) =>
        `- ${tool.name}: ${tool.description}. Parameters: ${JSON.stringify(tool.parameters)}`
    )
  ].join("\n")
)

const noToolsSettings = join(work, "no-tools-settings.json")
writeFileSync(
  noToolsSettings,
  JSON.stringify({ tools: { core: [] }, experimental: { enableAgents: false } }, null, 2)
)

const baseEnv = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" }
// Our own overrides only: a caller's GEMINI_SYSTEM_MD must not leak into the baseline.
delete baseEnv.GEMINI_SYSTEM_MD
delete baseEnv.GEMINI_CLI_SYSTEM_DEFAULTS_PATH

/** One headless call: the stream-json events, the reply text, tool calls and token stats. */
const headless = (label, prompt, env) =>
  new Promise((resolve) => {
    const argv = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "-e",
      "none",
      ...(model ? ["-m", model] : [])
    ]
    const child = spawn("gemini", argv, {
      cwd: work,
      env: { ...baseEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    })
    const outcome = {
      label,
      reply: "",
      toolUses: [],
      init: undefined,
      stats: undefined,
      errors: []
    }
    const timer = setTimeout(() => {
      outcome.errors.push(`timed out after ${callTimeoutMs / 1000}s`)
      child.kill()
    }, callTimeoutMs)
    createInterface({ input: child.stdout }).on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) return
      let json
      try {
        json = JSON.parse(trimmed)
      } catch {
        return
      }
      switch (json.type) {
        case "init":
          outcome.init = json
          break
        case "message":
          if (json.role === "assistant" && typeof json.content === "string") {
            outcome.reply += json.content
          }
          break
        case "tool_use":
          outcome.toolUses.push(json.tool_name ?? "?")
          break
        case "result":
          outcome.stats = json.stats
          if (json.status === "error") outcome.errors.push(JSON.stringify(json.error ?? json))
          break
        case "error":
          outcome.errors.push(json.message ?? trimmed)
          break
      }
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      outcome.errors.push(`failed to spawn gemini: ${error.message}`)
      resolve(outcome)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        outcome.errors.push(`exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`)
      }
      resolve(outcome)
    })
  })

/** Prompt (including cached), cached and output tokens over every model a call used. */
const tokensOf = (stats) => {
  const totals = { prompt: 0, cached: 0, output: 0 }
  for (const entry of Object.values(stats?.models ?? {})) {
    const tokens = entry?.tokens ?? {}
    totals.prompt += tokens.prompt ?? 0
    totals.cached += tokens.cached ?? 0
    totals.output += (tokens.candidates ?? 0) + (tokens.thoughts ?? 0)
  }
  return totals
}

const show = (outcome) => {
  const tokens = tokensOf(outcome.stats)
  console.log(`\n=== ${outcome.label} ===`)
  if (outcome.init !== undefined) console.log(`init: ${JSON.stringify(outcome.init)}`)
  console.log(`reply: ${JSON.stringify(outcome.reply.trim().slice(0, 300))}`)
  console.log(`tool calls: ${outcome.toolUses.length === 0 ? "none" : outcome.toolUses.join(", ")}`)
  console.log(
    `tokens: prompt ${tokens.prompt} (cached ${tokens.cached}) · output ${tokens.output} · tool calls in stats ${outcome.stats?.tools?.totalCalls ?? "?"}`
  )
  for (const error of outcome.errors) console.log(`ERROR: ${error}`)
  return tokens
}

/** The first `<tool_call>` block as `{name, arguments}`, or why it is not one. */
const parseToolCall = (reply) => {
  const match = /<tool_call>([\s\S]*?)<\/tool_call>/u.exec(reply)
  if (match === null) return { error: "no <tool_call> block" }
  try {
    const call = JSON.parse(match[1].trim())
    if (!piTools.some((tool) => tool.name === call.name))
      return { error: `unknown tool ${call.name}` }
    if (typeof call.arguments !== "object" || call.arguments === null) {
      return { error: "arguments is not an object" }
    }
    return { call }
  } catch (error) {
    return { error: `invalid JSON: ${error.message}` }
  }
}

/** ACP mode: does the override reach a session started by `--experimental-acp`? */
const acpCanary = () =>
  new Promise((resolve) => {
    const child = spawn("gemini", ["--experimental-acp", ...(model ? ["-m", model] : [])], {
      cwd: work,
      env: {
        ...baseEnv,
        GEMINI_SYSTEM_MD: plainPrompt,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: noToolsSettings
      },
      stdio: ["pipe", "pipe", "pipe"]
    })
    const result = { text: "", errors: [] }
    const pending = new Map()
    let nextId = 0
    const timer = setTimeout(() => {
      result.errors.push(`timed out after ${callTimeoutMs / 1000}s`)
      child.kill()
      resolve(result)
    }, callTimeoutMs)
    createInterface({ input: child.stdout }).on("line", (line) => {
      let json
      try {
        json = JSON.parse(line.trim())
      } catch {
        return
      }
      if (json.id !== undefined && pending.has(json.id)) {
        const done = pending.get(json.id)
        pending.delete(json.id)
        done(json)
        return
      }
      if (json.method === "session/update") {
        const update = json.params?.update ?? {}
        const kind = update.sessionUpdate ?? update.type
        if (kind === "agent_message_chunk" || kind === "content_chunk") {
          result.text += update.content?.text ?? ""
        }
      }
      // A permission request means a tool was offered after all: deny it.
      if (json.method === "session/request_permission" && json.id !== undefined) {
        result.errors.push("gemini asked to run a tool in ACP mode")
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: json.id, result: { outcome: { outcome: "cancelled" } } })}\n`
        )
      }
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      result.errors.push(`failed to spawn gemini: ${error.message}`)
      resolve(result)
    })
    const send = (method, params) =>
      new Promise((done) => {
        const id = ++nextId
        pending.set(id, done)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    const run = async () => {
      const init = await send("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "llm4ts-model-probe", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      })
      if (init.error !== undefined) throw new Error(`initialize: ${init.error.message}`)
      const session = await send("session/new", { cwd: work, mcpServers: [] })
      if (session.error !== undefined) throw new Error(`session/new: ${session.error.message}`)
      const prompted = await send("session/prompt", {
        sessionId: session.result.sessionId,
        prompt: [{ type: "text", text: "What is the canary? Reply with the canary only." }]
      })
      if (prompted.error !== undefined) throw new Error(`session/prompt: ${prompted.error.message}`)
    }
    run()
      .catch((error) => result.errors.push(error.message))
      .finally(() => {
        clearTimeout(timer)
        child.stdin.end()
        child.kill()
        resolve(result)
      })
  })

const main = async () => {
  console.log(`gemini model probe · model ${model ?? "(gemini's default)"} · work dir ${work}`)

  // 1. Baseline, then the system prompt replaced.
  const baseline = show(
    await headless("1a baseline (built-in system prompt)", "Reply with exactly: OK", {})
  )
  const replacedCall = await headless(
    "1b GEMINI_SYSTEM_MD replaced",
    "What is the canary? Reply with the canary only.",
    { GEMINI_SYSTEM_MD: plainPrompt }
  )
  const replaced = show(replacedCall)

  // 2. No tools, no sub-agents: asked to run a command, it must not call a tool.
  const noToolsEnv = {
    GEMINI_SYSTEM_MD: plainPrompt,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: noToolsSettings
  }
  const bare = await headless(
    "2 replaced prompt + tools.core [] + agents off",
    "Run the shell command `echo PROBE` and tell me its output.",
    noToolsEnv
  )
  const bareTokens = show(bare)

  // 3. The text tool-call protocol, fresh call per trial.
  console.log(`\n=== 3 tool-call protocol, ${trials} trial(s) ===`)
  const protocolEnv = {
    GEMINI_SYSTEM_MD: protocolPrompt,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: noToolsSettings
  }
  const asks = [
    { prompt: "Show me the contents of package.json.", expect: "read", key: "path" },
    { prompt: "Run the test suite with `pnpm test`.", expect: "bash", key: "command" }
  ]
  let valid = 0
  let right = 0
  for (let trial = 0; trial < trials; trial += 1) {
    const ask = asks[trial % asks.length]
    const outcome = await headless(`3.${trial + 1}`, ask.prompt, protocolEnv)
    const parsed = parseToolCall(outcome.reply)
    const ok = parsed.call !== undefined
    const correct =
      ok && parsed.call.name === ask.expect && typeof parsed.call.arguments[ask.key] === "string"
    valid += ok ? 1 : 0
    right += correct ? 1 : 0
    console.log(
      `trial ${trial + 1}: ${ok ? `${parsed.call.name} ${JSON.stringify(parsed.call.arguments)}` : `INVALID (${parsed.error})`}${correct ? "" : ` · expected ${ask.expect}`}${outcome.toolUses.length > 0 ? ` · NATIVE TOOL CALLS ${outcome.toolUses.join(",")}` : ""}${outcome.errors.length > 0 ? ` · ERROR ${outcome.errors[0]}` : ""}`
    )
  }

  // 4. ACP mode.
  const acp = skipAcp ? undefined : await acpCanary()
  if (acp !== undefined) {
    console.log("\n=== 4 ACP mode with the override ===")
    console.log(`reply: ${JSON.stringify(acp.text.trim().slice(0, 300))}`)
    for (const error of acp.errors) console.log(`ERROR: ${error}`)
  }

  const verdict = (ok) => (ok ? "yes" : "NO")
  const canaryBack = (text) => text.includes(canary)
  console.log("\n=== summary ===")
  console.log(
    `prompt tokens: baseline ${baseline.prompt} · replaced ${replaced.prompt} · replaced + no tools ${bareTokens.prompt}`
  )
  console.log(
    `1 override applies in headless mode (canary returned):   ${verdict(canaryBack(replacedCall.reply))}`
  )
  console.log(
    `2 no tool called with tools.core [] and agents off:      ${verdict(bare.toolUses.length === 0 && (bare.stats?.tools?.totalCalls ?? 0) === 0)}`
  )
  console.log(
    `3 tool-call protocol: ${valid}/${trials} well-formed, ${right}/${trials} the right tool with its argument`
  )
  console.log(
    `4 override applies in ACP mode (canary returned):        ${acp === undefined ? "skipped" : verdict(canaryBack(acp.text))}`
  )
  if (baseline.prompt > 0 && bareTokens.prompt > baseline.prompt / 2) {
    console.log(
      "\nThe prompt tokens did not fall by half: a user-level ~/.gemini/GEMINI.md, an extension, or a user settings.json overriding tools.core may still be loaded."
    )
  }
  rmSync(work, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
})
