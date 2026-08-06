/**
 * Packs every workspace package, installs the tarballs into a throwaway
 * consumer project, and imports the public entry points. This exercises the
 * published artifact (exports maps, dist output, dependency metadata) instead
 * of the workspace src aliases used by tests. Run after `pnpm build`.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packages = ["core", "flow", "runner", "modernize", "js", "shell"]

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  })

const workDir = mkdtempSync(path.join(tmpdir(), "llm4ts-pack-smoke-"))
try {
  const tarballs = {}
  for (const name of packages) {
    const output = run("pnpm", ["pack", "--pack-destination", workDir], {
      cwd: path.join(repoRoot, "packages", name)
    })
    const lines = output.trim().split("\n")
    tarballs[`@llm4ts/${name}`] = lines[lines.length - 1].trim()
  }

  const fileDeps = Object.fromEntries(
    Object.entries(tarballs).map(([pkg, tarball]) => [pkg, `file:${tarball}`])
  )
  writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify(
      {
        name: "llm4ts-pack-smoke",
        private: true,
        type: "module",
        dependencies: { ...fileDeps, effect: "4.0.0-beta.102" },
        overrides: fileDeps
      },
      null,
      2
    )
  )

  writeFileSync(
    path.join(workDir, "smoke.mjs"),
    `
import assert from "node:assert/strict"
import { ConnectorIds, Message } from "@llm4ts/core/Models"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { collect } from "@llm4ts/core/Streaming"
import { FlowContext } from "@llm4ts/flow/FlowContext"
import { AssistantMessage } from "@llm4ts/flow/FlowEvents"
import { runNode } from "@llm4ts/runner/FlowRunner"
import { makeModernize } from "@llm4ts/modernize/Modernize"
import { createClient } from "@llm4ts/js"
import { parseFlowDescription } from "@llm4ts/shell/FlowCatalog"

assert.equal(typeof runNode, "function")
assert.equal(typeof makeModernize, "function")
assert.equal(parseFlowDescription("// a demo flow\\n"), "a demo flow")
assert.equal(typeof collect, "function")
assert.ok(ConnectorIds.Mock)
assert.ok(Message)
assert.ok(FlowContext)
assert.ok(AssistantMessage)
assert.ok(ApiConnectorConfig)

const client = createClient({ provider: "mock", model: "mock" })
const response = await client.complete("Say hello")
assert.equal(typeof response.content, "string")
assert.ok(response.content.length > 0)
const health = await client.health()
assert.ok(health.availability)

console.log("pack smoke: all imports resolved, mock completion succeeded")
`
  )

  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: workDir })
  const result = run("node", ["smoke.mjs"], { cwd: workDir })
  process.stdout.write(result)

  // The published shell bin must resolve and its built-in flow tier must ship.
  const listOutput = run(path.join(workDir, "node_modules", ".bin", "llm4ts"), ["list", "--json"], {
    cwd: workDir,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(workDir, "xdg-config") }
  })
  const flows = JSON.parse(listOutput)
  if (!Array.isArray(flows) || !flows.some((flow) => flow.name === "implement")) {
    throw new Error(`llm4ts list --json did not include the built-in flows: ${listOutput}`)
  }
  console.log(`pack smoke: llm4ts bin listed ${flows.length} built-in flow(s)`)

  // Launching a built-in flow from the installed layout must load the script
  // and its @llm4ts imports from node_modules — Node refuses to strip types
  // there, so this catches a .ts flow ever sneaking back into the tier. The
  // flow is expected to start and fail on its own argument validation.
  let launch
  try {
    launch = run(
      path.join(workDir, "node_modules", ".bin", "llm4ts"),
      ["run", "modernize-survey", "--repo", path.join(workDir, "missing-repo")],
      {
        cwd: workDir,
        env: { ...process.env, XDG_CONFIG_HOME: path.join(workDir, "xdg-config") },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
  } catch (error) {
    launch = `${error.stdout ?? ""}${error.stderr ?? ""}`
  }
  if (!String(launch).includes("--repo is not a directory")) {
    throw new Error(`installed built-in flow did not launch: ${launch}`)
  }
  console.log("pack smoke: installed built-in flow launched from node_modules")
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
