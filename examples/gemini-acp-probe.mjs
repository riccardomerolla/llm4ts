#!/usr/bin/env node
/**
 * Diagnostic-only. Not part of the bridge, not part of `pnpm test`.
 *
 * Speaks raw ACP JSON-RPC to a real `gemini --experimental-acp` process,
 * one call at a time, printing the exact request and response for each
 * stage — isolating the protocol layer from pi and the bridge entirely, so
 * an "Internal error" (JSON-RPC -32603: the server's own handler threw)
 * can be pinned to the exact call that causes it instead of guessed at.
 *
 * Usage: node examples/gemini-acp-probe.mjs [model]
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const { console, process, setTimeout } = globalThis

const model = process.argv[2]
const argv = ["gemini", "--experimental-acp", ...(model ? ["-m", model] : [])]

console.log(`spawning: ${argv.join(" ")}\n`)
const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })

child.stderr.on("data", (chunk) => process.stderr.write(`[gemini stderr] ${chunk}`))
child.on("error", (error) => {
  console.error(`failed to spawn: ${error.message}`)
  process.exit(1)
})

const rl = createInterface({ input: child.stdout })
const pending = new Map()
let nextId = 0

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith("{")) {
    return
  }
  let json
  try {
    json = JSON.parse(trimmed)
  } catch {
    console.log(`[unparsed line] ${trimmed}`)
    return
  }
  if (json.id !== undefined && (json.result !== undefined || json.error !== undefined)) {
    const resolver = pending.get(json.id)
    if (resolver !== undefined) {
      pending.delete(json.id)
      resolver(json)
      return
    }
  }
  console.log(`[notification/request from gemini] ${trimmed}`)
})

const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    console.log(`--> ${line}`)
    child.stdin.write(`${line}\n`)
  })

const stage = async (label, method, params) => {
  console.log(`\n=== ${label} ===`)
  const response = await Promise.race([
    send(method, params),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 15000))
  ])
  if (response.timedOut) {
    console.log("<-- (timed out after 15s, no response)")
    return { ok: false, response }
  }
  console.log(`<-- ${JSON.stringify(response)}`)
  if (response.error !== undefined) {
    console.log(
      `FAILED at "${label}": code=${response.error.code} message=${response.error.message}`
    )
    if (response.error.data !== undefined) {
      console.log(`  data: ${JSON.stringify(response.error.data)}`)
    }
    return { ok: false, response }
  }
  console.log(`ok`)
  return { ok: true, response }
}

const main = async () => {
  const init = await stage("initialize", "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "llm4ts-probe", version: "1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  })
  if (!init.ok) {
    return finish(1)
  }

  const plain = await stage("session/new (no mcpServers)", "session/new", {
    cwd: process.cwd()
  })
  if (!plain.ok) {
    return finish(1)
  }

  const httpMcp = await stage("session/new (mcpServers: http)", "session/new", {
    cwd: process.cwd(),
    mcpServers: [{ type: "http", url: "http://127.0.0.1:8731/mcp" }]
  })
  if (!httpMcp.ok) {
    console.log(
      "\nThe plain session/new above worked, but adding an http-type mcpServers entry " +
        "broke it — this gemini build's ACP implementation likely doesn't support that " +
        "mcpServers variant yet. See ADR 0016 / GeminiAcpSession.ts's acpNewSessionParams."
    )
    return finish(1)
  }

  const sessionId = plain.response.result?.sessionId ?? httpMcp.response.result?.sessionId
  if (sessionId === undefined) {
    console.log("\nsession/new succeeded but returned no sessionId — check the raw response above.")
    return finish(1)
  }

  const prompted = await stage("session/prompt", "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Say hello in five words or fewer." }]
  })
  finish(prompted.ok ? 0 : 1)
}

const finish = (code) => {
  console.log(`\n${code === 0 ? "all stages passed" : "stopped at the first failing stage above"}`)
  child.stdin.end()
  child.kill()
  process.exit(code)
}

main()
