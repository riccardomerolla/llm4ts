#!/usr/bin/env node
// Smoke check for the internet-banking portal fixture: seeds into a temp
// dir, asserts the expected files exist and the seed commit is
// deterministic, then cleans up. Network-free; safe for CI.
//
//   node examples/internet-banking/smoke-portal.mjs

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEED_SCRIPT = path.join(HERE, "seed-portal.mjs")

const EXPECTED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "eslint.config.mjs",
  "index.html",
  ".gitignore",
  ".npmrc",
  "README.md",
  "CONTRIBUTING.md",
  // Kit
  "src/kit/theme.css",
  "src/kit/i18n.tsx",
  "src/kit/messages.ts",
  "src/kit/config.tsx",
  "src/kit/auth.tsx",
  "src/kit/api.ts",
  "src/kit/fake-transport.ts",
  "src/kit/components.tsx",
  "src/kit/navigation.tsx",
  "src/kit/format.ts",
  // Composition point and entry
  "src/App.tsx",
  "src/main.tsx",
  // Exemplar domain and features
  "src/contracts/profile.ts",
  "src/contracts/profile.fake.ts",
  "src/features/profilo/messages.ts",
  "src/features/profilo/route.tsx",
  "src/features/profilo/ProfiloScreen.tsx",
  "src/features/profilo/ProfiloScreen.test.tsx",
  "src/features/home/messages.ts",
  "src/features/home/route.tsx",
  "src/features/home/HomeScreen.tsx",
  // Rendered contract
  "contracts/openapi/profile.json",
  "scripts/openapi.ts"
]

const EXPECTED_HEAD = "Seed Banca Demo internet-banking portal fixture"

function fail(message) {
  process.stderr.write(`smoke-portal: FAIL ${message}\n`)
  process.exit(1)
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internet-banking-portal-"))
const target = path.join(tempRoot, "portal")

try {
  execFileSync("node", [SEED_SCRIPT, target], { stdio: ["ignore", "ignore", "inherit"] })

  for (const relative of EXPECTED_FILES) {
    if (!fs.existsSync(path.join(target, relative))) {
      fail(`missing ${relative}`)
    }
  }
  for (const excluded of ["node_modules", "dist", ".llm4ts"]) {
    if (fs.existsSync(path.join(target, excluded))) {
      fail(`${excluded} must not be seeded`)
    }
  }

  const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: target,
    encoding: "utf8"
  }).trim()
  if (subject !== EXPECTED_HEAD) {
    fail(`unexpected head commit subject: ${subject}`)
  }
  const author = execFileSync("git", ["log", "-1", "--format=%an <%ae> %aI"], {
    cwd: target,
    encoding: "utf8"
  }).trim()
  if (!author.startsWith("Banca Demo <demo@example.invalid> 2020-01-01")) {
    fail(`unexpected author/date: ${author}`)
  }
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" })
  if (status.trim().length !== 0) {
    fail(`seeded tree is not clean:\n${status}`)
  }

  process.stdout.write(`smoke-portal: OK (${EXPECTED_FILES.length} files, deterministic seed)\n`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
