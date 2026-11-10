#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version, for the GitHub Release.
// Exits 1 when the changelog has no such section, so a release without an
// entry stops before anything is published.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const notesFor = (changelog, version) => {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith("## "))
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim()
  return body.length === 0 ? undefined : body
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? "").replace(/^v/, "")
  const notes = notesFor(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version)
  if (notes === undefined) {
    console.error(`CHANGELOG.md has no "## ${version}" section with content`)
    process.exit(1)
  }
  console.log(notes)
}
