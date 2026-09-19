import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  commitAll,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  stubProgram,
  write
} from "./support/smoke.ts"

const targetPackageJson = JSON.stringify(
  {
    name: "acmecorp-storefront",
    dependencies: { next: "14.2.0", react: "18.3.0", "@tanstack/react-query": "5.0.0" }
  },
  null,
  2
)

const respondSource = `(prompt) => {
  const heading = (prompt.match(/## ([^"]+)"/) ?? [])[1] ?? "Unknown"
  return JSON.stringify({ markdown: "## " + heading + "\\n\\nFindings for " + heading + "." })
}`

describe("pack-fork", () => {
  it("forks the pack into .llm4ts/kits/forked, drops scaffold, and writes conventions.md", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)
    write(fixture.target, "package.json", targetPackageJson)
    commitAll(fixture.target, "seed the target repository")

    const result = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })

    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const forkedDir = join(fixture.target, ".llm4ts", "kits", "forked", "packs", "acmecorp-nextjs")

    const packMd = readFileSync(join(forkedDir, "pack.md"), "utf8")
    assert.strictEqual(packMd.split("\n")[0], "# Pack: acmecorp-nextjs")
    assert.notInclude(packMd, "scaffold:")
    assert.include(packMd, "source: cobol")

    const conventions = readFileSync(join(forkedDir, "conventions.md"), "utf8")
    assert.include(conventions, "## Tech Stack & Dependencies")
    assert.include(conventions, "## Naming, Routing & Architecture")
    assert.include(conventions, "## Shared Components, Design System & Style")
    assert.include(conventions, "## Auth, Permissions & Data Fetching")

    const reviewer = readFileSync(join(forkedDir, "reviewers", "target-conventions.md"), "utf8")
    assert.include(reviewer, "conventions.md")

    const readme = readFileSync(join(forkedDir, "README.md"), "utf8")
    assert.include(readme, "- [ ] Approved")
    assert.include(readme, "smoke")
    assert.include(readme, "acmecorp-nextjs")

    // The source pack's other sidecars (prompts/, reviewers/smoke-lens.md, lessons.md)
    // carried over verbatim.
    const forkedPrompts = readdirSync(join(forkedDir, "prompts"))
    assert.isTrue(forkedPrompts.includes("implement.md"))
    const forkedLessons = readFileSync(join(forkedDir, "lessons.md"), "utf8")
    assert.include(forkedLessons, "Lessons")
  })

  it("fails fast with a usage error when LLM4TS_TARGET_KIND is missing", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)

    const result = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })

    assert.notStrictEqual(result.status, 0)
    assert.include(`${result.stdout}${result.stderr}`, "LLM4TS_TARGET_KIND")
  })

  it("fails fast with a usage error when LLM4TS_FORK_AS is missing", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)

    const result = runFlow(fixture, "pack-fork", fixture.target, { LLM4TS_TARGET_KIND: "frontend" })

    assert.notStrictEqual(result.status, 0)
    assert.include(`${result.stdout}${result.stderr}`, "LLM4TS_FORK_AS")
  })
})
