// Workshop reset: (re)materialize the demo estate so every rehearsal and the
// real run start identical. Wipes ONLY the two repos it owns under the given
// root, re-seeds both fixtures, and warms the target's node_modules from the
// pnpm store (run once with network before demo day; offline afterwards).
import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] ?? ".demo-bank")
const legacy = join(root, "legacy-j2ee")
const target = join(root, "nextjs")

for (const path of [legacy, target]) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
    console.log(`removed ${path}`)
  }
}

const run = (command, args, cwd) =>
  execFileSync(command, args, { stdio: "inherit", ...(cwd === undefined ? {} : { cwd }) })

run("node", [join(here, "seed-legacy-j2ee.mjs"), legacy])
run("node", [join(here, "seed-nextjs.mjs"), target])

console.log("installing target dependencies (uses the warm pnpm store when offline)...")
try {
  run("pnpm", ["install", "--ignore-workspace", "--prefer-offline"], target)
} catch {
  console.error(
    "pnpm install failed — if you are offline, warm the store once with network:\n" +
      `  cd ${target} && pnpm install --ignore-workspace`
  )
  process.exit(1)
}

console.log(`\ndemo estate ready:\n  legacy: ${legacy}\n  target: ${target}`)
console.log(`next: export LLM4TS_LEGACY_REPO=${legacy} (see RUNBOOK.md Act 0)`)
