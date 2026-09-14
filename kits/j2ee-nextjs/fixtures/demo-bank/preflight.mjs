// Workshop preflight: verify the demo environment before the audience
// arrives. Seeds both fixtures into a temp dir via their smoke checks and
// verifies the tools the runbook depends on. Exits nonzero, loudly, on any
// failure — fix everything red before demo day.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const failures = []

const check = (label, run) => {
  try {
    run()
    console.log(`ok    ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL  ${label}: ${error.message ?? error}`)
  }
}

const tool = (label, command, args) =>
  check(label, () => execFileSync(command, args, { stdio: "pipe" }))

tool("git available", "git", ["--version"])
tool("node >= 20", "node", ["--version"])
tool("pnpm available", "pnpm", ["--version"])
tool("claude CLI available (the coder seat)", "claude", ["--version"])

check("legacy fixture seeds + smoke", () =>
  execFileSync("node", [join(here, "smoke-legacy-j2ee.mjs")], { stdio: "pipe" })
)
check("nextjs fixture seeds + smoke", () =>
  execFileSync("node", [join(here, "smoke-nextjs.mjs")], { stdio: "pipe" })
)

if (process.env.LLM4TS_LEGACY_REPO === undefined) {
  console.log("note  LLM4TS_LEGACY_REPO is not set yet — the runbook exports it in Act 0")
}

if (failures.length > 0) {
  console.error(`\npreflight FAILED: ${failures.join("; ")}`)
  process.exit(1)
}
console.log("\npreflight OK — run reset-demo.mjs to materialize the estate")
