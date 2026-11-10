#!/usr/bin/env node
// Fails when a module under packages/*/src is imported by no production file,
// or when modules there import each other in a circle.
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
  "packages/runner/src/McpStdio.ts": "kept by decision (3.0.0 cleanup)"
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
// scripts/sync-shell-flows.mjs copies flows/ and kits/ here at build time; a
// stale copy must not count as an importer.
const buildCopies = ["packages/shell/flows/", "packages/shell/kits/"]
const production = ["packages", "flows", "kits", "tools", "scripts", "examples"]
  .flatMap((dir) => walk(path.join(root, dir)))
  .filter((file) => !isTest(file) && !buildCopies.some((copy) => file.startsWith(copy)))

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
/** The source file an import specifier in `file` names, when it is one of ours. */
const resolveSpecifier = (file, spec) => {
  if (spec.startsWith(".")) {
    return path.normalize(path.join(path.dirname(file), spec)).replace(/\.js$/, ".ts")
  }
  const match = /^@llm4ts\/([^/]+)(?:\/(.+))?$/.exec(spec)
  if (match === null || manifests[match[1]] === undefined) return undefined
  const exported = manifests[match[1]].exports?.[match[2] === undefined ? "." : `./${match[2]}`]
  return typeof exported === "string" ? sourceOf(match[1], exported) : undefined
}

const importsOf = (file) =>
  [...readFileSync(path.join(root, file), "utf8").matchAll(specifier)]
    .map(([, spec]) => resolveSpecifier(file, spec))
    .filter((target) => target !== undefined && target !== file)

for (const file of production) {
  for (const target of importsOf(file)) used.add(target)
}

// Import cycles among the package sources, type-only imports included: two
// modules that name each other cannot be read, moved or tested one at a time.
// Tarjan's strongly connected components; any component of two or more is a
// cycle.
const moduleSet = new Set(modules)
const graph = new Map(
  modules.map((file) => [file, importsOf(file).filter((target) => moduleSet.has(target))])
)
const cycles = []
{
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const visit = (node) => {
    index.set(node, index.size)
    low.set(node, index.get(node))
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node)) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)))
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      if (component.length > 1) cycles.push(component.sort())
    }
  }
  for (const file of modules) if (!index.has(file)) visit(file)
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
}
for (const cycle of cycles) {
  console.error(`import cycle: ${cycle.join(" <-> ")}`)
  for (const file of cycle) {
    for (const target of graph.get(file).filter((next) => cycle.includes(next))) {
      console.error(`  ${file} imports ${target}`)
    }
  }
}
if (cycles.length > 0) {
  console.error(
    "\nModules under packages/*/src must not import each other in a circle, type-only imports included. Move the shared type or value into the module both can depend on."
  )
}
if (unexpected.length > 0 || stale.length > 0 || cycles.length > 0) process.exit(1)
console.log(
  `unused modules: none (${modules.length} checked, ${Object.keys(ALLOWED).length} allowed); import cycles: none`
)
