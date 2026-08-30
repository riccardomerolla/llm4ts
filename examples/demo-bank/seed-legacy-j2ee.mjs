#!/usr/bin/env node
// Materialize the synthetic legacy J2EE fixture (examples/demo-bank/legacy-j2ee)
// as a standalone git repository. The demo flows need a real repo root, not a
// subdirectory of llm4ts.
//
//   node examples/demo-bank/seed-legacy-j2ee.mjs [target-dir] [--force]
//
// Default target: .demo-bank/legacy-j2ee under the current working directory.
// Refuses to overwrite a non-empty target unless --force is given.
// Deterministic: fixed commit author/committer and date, no network.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(scriptDir, "legacy-j2ee")

const args = process.argv.slice(2)
const force = args.includes("--force")
const positional = args.filter((a) => a !== "--force")

if (positional.some((a) => a.startsWith("--"))) {
  console.error(`unknown flag: ${positional.find((a) => a.startsWith("--"))}`)
  console.error("usage: node seed-legacy-j2ee.mjs [target-dir] [--force]")
  process.exit(2)
}
if (positional.length > 1) {
  console.error("only one target directory may be supplied")
  process.exit(2)
}

const target = path.resolve(positional[0] ?? path.join(process.cwd(), ".demo-bank", "legacy-j2ee"))

if (!fs.existsSync(fixtureDir)) {
  console.error(`fixture source missing: ${fixtureDir}`)
  process.exit(1)
}

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  if (!force) {
    console.error(`target is not empty: ${target} (use --force to overwrite)`)
    process.exit(2)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

fs.mkdirSync(target, { recursive: true })
fs.cpSync(fixtureDir, target, { recursive: true })

// Fixed identity and date so seeded repos are deterministic.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Demo Bank",
  GIT_AUTHOR_EMAIL: "demo@example.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Demo Bank",
  GIT_COMMITTER_EMAIL: "demo@example.invalid",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z"
}

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: target, env: gitEnv, stdio: "pipe" })

git("init", "-q", "-b", "main")
git("add", "-A")
git("commit", "-q", "-m", "Import DemoBank legacy portal")

console.log(target)
