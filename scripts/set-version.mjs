/**
 * Sets the version of every publishable workspace package in lockstep, so a
 * release is always: `pnpm version:set X.Y.Z`, commit, tag `vX.Y.Z`, push.
 * The release workflow refuses to publish when the tag and versions disagree.
 */
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <X.Y.Z>")
  process.exit(2)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
for (const name of ["core", "flow", "runner", "modernize", "js", "shell"]) {
  const manifestPath = path.join(repoRoot, "packages", name, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.version = version
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`@llm4ts/${name} -> ${version}`)
}
