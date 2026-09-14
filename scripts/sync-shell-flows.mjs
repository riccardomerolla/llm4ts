/**
 * Transpiles the repository's top-level flows/ scripts into
 * packages/shell/flows as plain .js, the built-in tier shipped inside the
 * @llm4ts/shell npm package, together with the resources the modernize flows
 * locate relative to their own directory: packs/, patterns/, and fixtures/
 * (scaffolds the packs point at). The flows must ship as JavaScript: Node
 * refuses to strip types from .ts files under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an installed shell could
 * never launch a .ts built-in. Run as part of `pnpm build` so the copies can
 * never drift from the source of truth.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceDir = path.join(repoRoot, "flows")
const targetDir = path.join(repoRoot, "packages", "shell", "flows")
const resourceDirs = ["fixtures"]

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })

/**
 * Relative imports between flow sources name `.ts` files (the repository
 * rule); the shipped copies are `.js`, so the specifiers are rewritten
 * with them. Package imports are untouched.
 */
const rewriteRelativeImports = (source) =>
  source.replace(/(from\s+["'])(\.\.?\/[^"']+)\.ts(["'])/g, "$1$2.js$3")

const transpile = (source, fileName) =>
  rewriteRelativeImports(
    ts.transpileModule(source, {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: false
      }
    }).outputText
  )

let copied = 0
for (const entry of readdirSync(sourceDir)) {
  if (!entry.endsWith(".ts")) {
    continue
  }
  const source = readFileSync(path.join(sourceDir, entry), "utf8")
  writeFileSync(path.join(targetDir, entry.replace(/\.ts$/, ".js")), transpile(source, entry))
  copied += 1
}
// The flows' shared library (`flows/lib/*.ts`, imported as `./lib/<name>.ts`
// by the convert-* and epic-stories flows) ships beside them the same way.
const libDir = path.join(sourceDir, "lib")
if (existsSync(libDir)) {
  mkdirSync(path.join(targetDir, "lib"), { recursive: true })
  for (const entry of readdirSync(libDir)) {
    if (!entry.endsWith(".ts")) {
      continue
    }
    const source = readFileSync(path.join(libDir, entry), "utf8")
    writeFileSync(
      path.join(targetDir, "lib", entry.replace(/\.ts$/, ".js")),
      transpile(source, entry)
    )
    copied += 1
  }
}
for (const name of resourceDirs) {
  const source = path.join(sourceDir, name)
  if (existsSync(source)) {
    cpSync(source, path.join(targetDir, name), { recursive: true })
  }
}

/**
 * Kits ship beside the engine flows as packages/shell/kits/<kit>/ (ADR 0014):
 * kit flows transpiled to .js like the engine's, and the packs, scaffolds,
 * pattern cards, fixtures, and README copied as data. Untracked build litter
 * inside a fixture (node_modules, dist, .next, .llm4ts) never ships.
 */
const kitsSourceDir = path.join(repoRoot, "kits")
const kitsTargetDir = path.join(repoRoot, "packages", "shell", "kits")
const litter = new Set(["node_modules", "dist", ".next", ".llm4ts", ".tsbuildinfo", "coverage"])
const copyData = (source, target) =>
  cpSync(source, target, {
    recursive: true,
    filter: (candidate) => !litter.has(path.basename(candidate))
  })
const transpileTree = (source, target) => {
  let count = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "test") {
      continue
    }
    const from = path.join(source, entry.name)
    if (entry.isDirectory()) {
      count += transpileTree(from, path.join(target, entry.name))
    } else if (entry.name.endsWith(".ts")) {
      mkdirSync(target, { recursive: true })
      writeFileSync(
        path.join(target, entry.name.replace(/\.ts$/, ".js")),
        transpile(readFileSync(from, "utf8"), entry.name)
      )
      count += 1
    }
  }
  return count
}
rmSync(kitsTargetDir, { recursive: true, force: true })
let kitFlows = 0
// A kit is a directory holding packs/ or flows/ (ADR 0014); the workspace
// package's own dist, node_modules, and test directories are not kits.
const kitNames = existsSync(kitsSourceDir)
  ? readdirSync(kitsSourceDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !litter.has(entry.name) &&
          (existsSync(path.join(kitsSourceDir, entry.name, "packs")) ||
            existsSync(path.join(kitsSourceDir, entry.name, "flows")))
      )
      .map((entry) => entry.name)
  : []
for (const kit of kitNames) {
  const kitSource = path.join(kitsSourceDir, kit)
  const kitTarget = path.join(kitsTargetDir, kit)
  mkdirSync(kitTarget, { recursive: true })
  for (const name of ["packs", "scaffolds", "patterns", "fixtures"]) {
    if (existsSync(path.join(kitSource, name))) {
      copyData(path.join(kitSource, name), path.join(kitTarget, name))
    }
  }
  if (existsSync(path.join(kitSource, "README.md"))) {
    cpSync(path.join(kitSource, "README.md"), path.join(kitTarget, "README.md"))
  }
  if (existsSync(path.join(kitSource, "flows"))) {
    kitFlows += transpileTree(path.join(kitSource, "flows"), path.join(kitTarget, "flows"))
  }
}
console.log(
  `sync-shell-flows: copied ${copied} flow(s) and ${resourceDirs.join("/")} into packages/shell/flows, ` +
    `${kitNames.length} kit(s) with ${kitFlows} flow file(s) into packages/shell/kits`
)
