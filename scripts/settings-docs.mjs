#!/usr/bin/env node
// Writes the settings reference into docs/configuration.md, between the
// `<!-- settings:begin -->` and `<!-- settings:end -->` lines, from the
// registry in packages/flow/src/settings/Registry.ts.
//
//   node scripts/settings-docs.mjs           rewrite the region
//   node scripts/settings-docs.mjs --check   exit 1 when the region differs
//
// It imports the TypeScript source, so it needs a Node that strips types
// (22.18 or later). examples/test/settings-sync.test.ts makes the same
// comparison in `pnpm test`.
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const file = path.join(root, "docs", "configuration.md")
const begin = "<!-- settings:begin -->"
const end = "<!-- settings:end -->"

const { settingsReference } = await import("../packages/flow/src/Settings.ts")

const text = readFileSync(file, "utf8")
const from = text.indexOf(begin)
const to = text.indexOf(end)
if (from < 0 || to < from) {
  console.error(`docs/configuration.md needs a ${begin} line followed by a ${end} line`)
  process.exit(2)
}
const next = `${text.slice(0, from)}${begin}\n\n${settingsReference()}\n\n${text.slice(to)}`

if (next === text) {
  console.log("docs/configuration.md: the settings reference is current")
} else if (process.argv.includes("--check")) {
  console.error(
    "docs/configuration.md: the settings reference differs from the registry; run `node scripts/settings-docs.mjs`"
  )
  process.exit(1)
} else {
  writeFileSync(file, next)
  console.log("docs/configuration.md: settings reference rewritten")
}
