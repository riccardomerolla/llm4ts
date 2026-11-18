#!/usr/bin/env node
// Fails when a module under packages/*/src is imported by no production file,
// when modules there import each other in a circle, when a package's source or
// tests import a package above it, and when the public surface (ADR 0050)
// drifts: a package.json `exports` map that differs from the one derived from
// the sources, an outside import of an internal module, an `export *`, or a
// doc naming a subpath that is not exported.
//
// A module whose first line is `// @internal: <reason>` is not exported; every
// other module is a public subpath. `--write-exports` rewrites the maps.
//
// Unused asks: does any non-test file in the packages, flows, kits, tools,
// scripts or examples import it? A module only its own tests import is dead
// weight unless ALLOWED below says why it stays.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const writeExports = process.argv.includes("--write-exports")

/** Packages whose only surface is their bin: every module is internal. */
const BIN_ONLY = new Set(["shell"])

/** Modules kept on purpose with no production importer, and why. */
const ALLOWED = {
  "packages/core/src/eval/Checks.ts": "eval library, public API",
  "packages/core/src/eval/EvalSuite.ts": "eval library, public API",
  "packages/flow/src/BasecampTool.ts": "consumed by sibling projects"
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
const moduleSet = new Set(modules)
const packageOf = (file) => /^packages\/([^/]+)\//.exec(file)?.[1]
/** `packages/flow/src/tools/Diff.ts` → `tools/Diff`. */
const subpathOf = (file) => file.replace(/^packages\/[^/]+\/src\//, "").replace(/\.ts$/, "")

const markerProblems = []
const internal = new Map()
for (const file of modules) {
  const firstLine = readFileSync(path.join(root, file), "utf8").split("\n", 1)[0]
  const marked = /^\/\/ @internal: (\S.*)$/.exec(firstLine)
  if (marked !== null) internal.set(file, marked[1])
  else if (firstLine.includes("@internal")) {
    markerProblems.push(`${file}: the marker is \`// @internal: <reason>\`, on the first line`)
  } else if (BIN_ONLY.has(packageOf(file))) internal.set(file, "the package is its bin")
}
// scripts/sync-shell-flows.mjs copies flows/ and kits/ here at build time; a
// stale copy must not count as an importer.
const buildCopies = ["packages/shell/flows/", "packages/shell/kits/"]
const everyFile = ["packages", "flows", "kits", "tools", "scripts", "examples"]
  .flatMap((dir) => walk(path.join(root, dir)))
  .filter((file) => !buildCopies.some((copy) => file.startsWith(copy)))
const production = everyFile.filter((file) => !isTest(file))

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
  // A subpath names its source whether or not the map exports it, as the
  // workspace aliases do: the surface checks below decide if it may.
  if (match[2] !== undefined) return path.join("packages", match[1], "src", `${match[2]}.ts`)
  const exported = manifests[match[1]].exports?.["."]
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

// Package direction: core → flow → runner → {js, shell}. A package imports only
// packages on a lower layer; js and shell share a layer, so neither imports the
// other, and the runner keeps zero knowledge of the shell (ADR 0006).
const layer = { core: 0, flow: 1, runner: 2, js: 3, shell: 3 }
for (const pkg of packages) {
  if (layer[pkg] === undefined) {
    console.error(`package ${pkg} has no layer in scripts/unused-modules.mjs`)
    process.exit(1)
  }
}
const packageOfSpecifier = (file, spec) => {
  const named = /^@llm4ts\/([^/]+)/.exec(spec)
  if (named !== null) return named[1]
  if (!spec.startsWith(".")) return undefined
  return /^packages\/([^/]+)\//.exec(path.normalize(path.join(path.dirname(file), spec)))?.[1]
}
const upward = packages
  .flatMap((pkg) => ["src", "test"].flatMap((dir) => walk(path.join(root, "packages", pkg, dir))))
  .flatMap((file) => {
    const from = /^packages\/([^/]+)\//.exec(file)[1]
    return [...readFileSync(path.join(root, file), "utf8").matchAll(specifier)].flatMap(
      ([, spec]) => {
        const to = packageOfSpecifier(file, spec)
        return to !== undefined && to !== from && !(layer[to] < layer[from])
          ? [`${file} imports ${spec} (${from} must not depend on ${to})`]
          : []
      }
    )
  })
for (const violation of upward) console.error(`upward import: ${violation}`)
if (upward.length > 0) {
  console.error(
    "\nPackages depend in one direction: core → flow → runner → {js, shell}. Move the shared code down to the lower package."
  )
}

// Public surface (ADR 0050). The root entry stays as each manifest declares
// it; every other subpath is derived from the non-internal modules.
const expectedExports = (pkg) => {
  const rootEntry = manifests[pkg].exports?.["."]
  const subpaths = modules
    .filter((file) => packageOf(file) === pkg && !internal.has(file))
    .map(subpathOf)
    .filter((subpath) => subpath !== "index")
    .sort()
  return Object.fromEntries([
    ...(rootEntry === undefined ? [] : [[".", rootEntry]]),
    ...subpaths.map((subpath) => [`./${subpath}`, `./dist/${subpath}.js`]),
    ["./package.json", "./package.json"]
  ])
}
const surface = [...markerProblems]
for (const pkg of packages) {
  const manifestPath = path.join("packages", pkg, "package.json")
  const expected = expectedExports(pkg)
  if (expected["."] !== undefined && internal.has(sourceOf(pkg, expected["."]))) {
    surface.push(`${manifestPath}: the root entry ${expected["."]} is an internal module`)
  }
  if (writeExports) {
    manifests[pkg].exports = expected
    writeFileSync(path.join(root, manifestPath), `${JSON.stringify(manifests[pkg], null, 2)}\n`)
    continue
  }
  const actual = manifests[pkg].exports ?? {}
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) surface.push(`${manifestPath}: exports lacks "${key}": "${value}"`)
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) surface.push(`${manifestPath}: exports "${key}", not a public module`)
  }
}
// tools/ and scripts/ never ship, so they may reach an internal module by
// relative path; a subpath import of one fails for every importer.
const repositoryOnly = /^(tools|scripts)\//
for (const file of everyFile) {
  for (const [, spec] of readFileSync(path.join(root, file), "utf8").matchAll(specifier)) {
    const target = resolveSpecifier(file, spec)
    if (!internal.has(target) || file.startsWith(`packages/${packageOf(target)}/`)) continue
    if (spec.startsWith(".") && repositoryOnly.test(file)) continue
    surface.push(
      `${file} imports ${spec}, internal to @llm4ts/${packageOf(target)} (${internal.get(target)})`
    )
  }
}
for (const file of modules) {
  if (/^\s*export\s*\*/m.test(readFileSync(path.join(root, file), "utf8"))) {
    surface.push(`${file}: \`export *\` hides what the module exports; name each export`)
  }
}
for (const doc of ["docs/api.md", "docs/flow-authoring.md"]) {
  const text = readFileSync(path.join(root, doc), "utf8")
  for (const [named, pkg, subpath] of text.matchAll(
    /@llm4ts\/([a-z]+)\/([A-Za-z]+(?:\/[A-Za-z]+)*)(?![\w/*])/g
  )) {
    if (manifests[pkg] !== undefined && !(`./${subpath}` in expectedExports(pkg))) {
      surface.push(`${doc} names ${named}, which is not exported`)
    }
  }
}
for (const problem of surface) console.error(`public surface: ${problem}`)
if (surface.length > 0) {
  console.error(
    "\nThe exports maps follow the sources (ADR 0050): mark a module `// @internal: <reason>` on its first line to keep it out, then run `pnpm exports:write` (node scripts/unused-modules.mjs --write-exports)."
  )
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
if (
  unexpected.length > 0 ||
  stale.length > 0 ||
  cycles.length > 0 ||
  upward.length > 0 ||
  surface.length > 0
) {
  process.exit(1)
}
const publicCounts = packages
  .map((pkg) => `${pkg} ${Object.keys(expectedExports(pkg)).length}`)
  .join(", ")
console.log(
  `unused modules: none (${modules.length} checked, ${Object.keys(ALLOWED).length} allowed); import cycles: none; upward package imports: none; exports (${publicCounts}) match the sources, ${internal.size} modules internal`
)
