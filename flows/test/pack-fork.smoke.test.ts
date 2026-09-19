import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import {
  commitAll,
  flowsRoot,
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

  it("caps the grounding-heavy Tech Stack & Dependencies prompt instead of shipping it unbounded", () => {
    const fixture = makeFixture()
    // Only the first pass (Tech Stack & Dependencies) carries grounding file
    // content — a real package.json can make its prompt far larger than the
    // other three, ungrounded passes. Fail loudly if that prompt isn't
    // bounded, so an oversized-prompt regression (truncated, unparseable
    // structured responses over a real model) shows up offline too.
    const responder = `(prompt) => {
      const heading = (prompt.match(/## ([^"]+)"/) ?? [])[1] ?? "Unknown"
      if (heading === "Tech Stack & Dependencies" && prompt.length > 10000) {
        console.error(
          "expected the oversized grounding prompt to be capped, got " + prompt.length + " chars"
        )
        process.exit(9)
      }
      return JSON.stringify({ markdown: "## " + heading + "\\n\\nFindings for " + heading + "." })
    }`
    installStub(fixture, stubProgram(responder))
    initRepo(fixture.target)
    write(fixture.target, "package.json", "x".repeat(60_000))
    commitAll(fixture.target, "seed the target repository")

    const result = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs",
      LLM4TS_CONTEXT_BUDGET: "3000"
    })

    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })

  it.effect(
    "round-trips the forked pack through loadPack, as a real modernize-implement run would",
    () =>
      Effect.gen(function* () {
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

        const workspace = yield* makeNodeWorkspace(fixture.target)
        const pack = yield* loadPack(
          workspace,
          join(".llm4ts", "kits", "forked", "packs", "acmecorp-nextjs")
        )

        assert.isDefined(pack.conventions)
        assert.isUndefined(pack.scaffold)
        assert.isTrue(pack.lenses.some((lens) => lens.name === "target-conventions"))
      })
  )

  it("clears stale files from a previous fork under the same name on re-run", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)
    write(fixture.target, "package.json", targetPackageJson)
    commitAll(fixture.target, "seed the target repository")

    const first = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })
    assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`)

    const forkedDir = join(fixture.target, ".llm4ts", "kits", "forked", "packs", "acmecorp-nextjs")
    assert.isTrue(existsSync(join(forkedDir, "prompts", "implement.md")))

    // Delete a prompt from the SOURCE pack fixture, then re-fork under the
    // same LLM4TS_FORK_AS name.
    rmSync(join(fixture.root, "packs", "smoke", "prompts", "implement.md"))

    const second = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })
    assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`)

    assert.isFalse(existsSync(join(forkedDir, "prompts", "implement.md")))
  })

  it("fails fast, without deleting the fork, when LLM4TS_PACK and LLM4TS_FORK_AS resolve to the same pack", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)
    write(fixture.target, "package.json", targetPackageJson)
    commitAll(fixture.target, "seed the target repository")

    const first = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })
    assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`)

    const forkedDir = join(fixture.target, ".llm4ts", "kits", "forked", "packs", "acmecorp-nextjs")
    assert.isTrue(existsSync(join(forkedDir, "pack.md")))

    // The documented re-fork workflow: cd into the target repo (cwd = target,
    // no --repo flag needed since it defaults to "."), then LLM4TS_PACK
    // pointed at the fork itself, with the same LLM4TS_FORK_AS — the exact
    // shape that made the flow delete its own input before this guard existed.
    const second = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(flowsRoot, "pack-fork.ts")],
      {
        cwd: fixture.target,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          LLM4TS_PACK: "forked/acmecorp-nextjs",
          LLM4TS_CODER: "claude",
          LLM4TS_VERBOSITY: "quiet",
          LLM4TS_TARGET_KIND: "frontend",
          LLM4TS_FORK_AS: "acmecorp-nextjs"
        }
      }
    )

    assert.notStrictEqual(second.status, 0)
    assert.include(`${second.stdout}${second.stderr}`, "LLM4TS_FORK_AS")
    // The guard must fire before the "clean" stage — the fork survives untouched.
    assert.isTrue(existsSync(join(forkedDir, "pack.md")))
    assert.isTrue(existsSync(join(forkedDir, "conventions.md")))
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
