/**
 * Copies the repository's top-level flows/ scripts into packages/shell/flows,
 * the built-in tier shipped inside the @llm4ts/shell npm package. Run as part
 * of `pnpm build` so the copies can never drift from the source of truth.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceDir = path.join(repoRoot, "flows")
const targetDir = path.join(repoRoot, "packages", "shell", "flows")

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })

let copied = 0
for (const entry of readdirSync(sourceDir)) {
  if (!entry.endsWith(".ts")) {
    continue
  }
  cpSync(path.join(sourceDir, entry), path.join(targetDir, entry))
  copied += 1
}
console.log(`sync-shell-flows: copied ${copied} flow(s) into packages/shell/flows`)
