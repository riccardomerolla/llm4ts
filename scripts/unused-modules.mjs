#!/usr/bin/env node
// Fails when a module under packages/*/src is imported by no production file.
//
// Every module is a public subpath export, so an export-map-aware tool sees
// each one as an entry point and can never call it unused. This check asks the
// narrower question that matters here: does any non-test file in the packages,
// flows, kits, tools, scripts or examples import it? A module only its own
// tests import is dead weight unless ALLOWED below says why it stays.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Modules kept on purpose with no production importer, and why. */
const ALLOWED = {
  "packages/core/src/providers/ClaudeAgentSession.ts": "session seam for delegation (ADR 0035)",
  "packages/core/src/eval/Checks.ts": "eval library, public API",
  "packages/core/src/eval/EvalSuite.ts": "eval library, public API",
  "packages/flow/src/BasecampTool.ts": "consumed by sibling projects",
  "packages/flow/src/Classified.ts": "sealed values; the judgment log's redaction contract",
  "packages/flow/src/Mermaid.ts": "kept by decision (3.0.0 cleanup)",
  "packages/runner/src/McpStdio.ts": "kept by decision (3.0.0 cleanup)",
  "packages/shell/src/Config.ts": "wired by the config verb (config-ux unit 3)"
}

const skipDirs = new Set(["node_modules", "dist", ".repos", "repos", ".git", ".llm4ts", ".claude"])
const isTest = (file) =>
  /(^|\/)test\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)fixtures\//.test(file)

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name), out)
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path.relative(root, path.join(dir, entry.name)))
    }
  }
  return out
}

const packages = readdirSync(path.join(root, "packages")).filter((name) =>
  existsSync(path.join(root, "packages", name, "package.json"))
)
const manifests = Object.fromEntries(
  packages.map((name) => [
    name,
    JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8"))
  ])
)
const sourceOf = (pkg, distPath) =>
  path.join("packages", pkg, distPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"))

const modules = packages.flatMap((pkg) => walk(path.join(root, "packages", pkg, "src")))
const production = ["packages", "flows", "kits", "tools", "scripts", "examples"]
  .flatMap((dir) => walk(path.join(root, dir)))
  .filter((file) => !isTest(file))

const used = new Set()
// Entry points: what a package's root export and its bin run.
for (const [pkg, manifest] of Object.entries(manifests)) {
  const rootExport = manifest.exports?.["."]
  if (typeof rootExport === "string") used.add(sourceOf(pkg, rootExport))
  for (const bin of Object.values(manifest.bin ?? {})) {
    used.add(sourceOf(pkg, bin.startsWith("./") ? bin : `./${bin}`))
  }
}

// `from "x"`, `import "x"`, `import("x")`, and `new URL("./x", import.meta.url)`
// (a module handed to a child process by path).
const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)["']([^"']+)["']/g
for (const file of production) {
  const text = readFileSync(path.join(root, file), "utf8")
  for (const [, spec] of text.matchAll(specifier)) {
    let target
    if (spec.startsWith(".")) {
      target = path.normalize(path.join(path.dirname(file), spec))
    } else {
      const match = /^@llm4ts\/([^/]+)(?:\/(.+))?$/.exec(spec)
      if (match === null || manifests[match[1]] === undefined) continue
      const exported = manifests[match[1]].exports?.[match[2] === undefined ? "." : `./${match[2]}`]
      if (typeof exported !== "string") continue
      target = sourceOf(match[1], exported)
    }
    if (target !== file) used.add(target.replace(/\.js$/, ".ts"))
  }
}

const unused = modules.filter((file) => !used.has(file))
const unexpected = unused.filter((file) => !(file in ALLOWED))
const stale = Object.keys(ALLOWED).filter((file) => !unused.includes(file))

for (const file of unexpected) console.error(`unused module: ${file}`)
for (const file of stale) console.error(`stale allowlist entry (now used, or gone): ${file}`)
if (unexpected.length > 0 || stale.length > 0) {
  console.error(
    "\nA module under packages/*/src needs a production importer. Remove it, use it, or add it to ALLOWED in scripts/unused-modules.mjs with the reason it stays."
  )
  process.exit(1)
}
console.log(
  `unused modules: none (${modules.length} checked, ${Object.keys(ALLOWED).length} allowed)`
)
