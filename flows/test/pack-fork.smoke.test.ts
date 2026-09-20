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
  smokeTimeout,
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

// Selection calls carry the literal "Candidate file paths (" marker
// (groundingSelectionAsk); everything else is a category pass call. The
// default selection here grounds only Tech Stack & Dependencies on
// package.json, leaving the other three categories with no grounding —
// matching the single-file fixture these tests seed.
const respondSource = `(prompt) => {
  if (prompt.includes("Candidate file paths (")) {
    return JSON.stringify({
      selections: [{ category: "Tech Stack & Dependencies", path: "package.json", reason: "manifest" }]
    })
  }
  const heading = (prompt.match(/## ([^"]+)"/) ?? [])[1] ?? "Unknown"
  return JSON.stringify({ markdown: "## " + heading + "\\n\\nFindings for " + heading + "." })
}`

describe("pack-fork", { timeout: smokeTimeout }, () => {
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

    const provenance = readFileSync(join(forkedDir, "provenance.md"), "utf8")
    assert.include(provenance, "package.json")
    assert.include(provenance, "## Tech Stack & Dependencies")
    // The other three categories got no selection from this fixture's stub —
    // that must show up as an explicit empty note, not silence.
    assert.include(provenance, "No files selected")

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
      if (prompt.includes("Candidate file paths (")) {
        return JSON.stringify({
          selections: [{ category: "Tech Stack & Dependencies", path: "package.json", reason: "manifest" }]
        })
      }
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

  it("caps the file-selection prompt when the repository has many candidate files", () => {
    const fixture = makeFixture()
    // The selection call embeds the full candidate path list — a repository
    // with many files could make that prompt large even though no single
    // file's content is involved yet (selection only ever sees paths). Once
    // capped, the truncation can cut the "Candidate file paths (" marker
    // itself out of the visible text, so detect the selection call by being
    // FIRST (a counter file, since each stub invocation is a fresh process
    // with no shared memory) rather than by matching text that capping can
    // remove.
    const responder = `(prompt) => {
      const counterPath = path.join(__dirname, "..", "call-count.txt")
      let count = 0
      try { count = parseInt(fs.readFileSync(counterPath, "utf8"), 10) || 0 } catch {}
      fs.writeFileSync(counterPath, String(count + 1))
      if (count === 0) {
        if (prompt.length > 10000) {
          console.error(
            "expected the file-listing selection prompt to be capped, got " + prompt.length + " chars"
          )
          process.exit(9)
        }
        return JSON.stringify({ selections: [] })
      }
      const heading = (prompt.match(/## ([^"]+)"/) ?? [])[1] ?? "Unknown"
      return JSON.stringify({ markdown: "## " + heading + "\\n\\nFindings for " + heading + "." })
    }`
    installStub(fixture, stubProgram(responder))
    initRepo(fixture.target)
    for (let index = 0; index < 500; index += 1) {
      write(fixture.target, `src/component-${index}.tsx`, "export {}\n")
    }
    commitAll(fixture.target, "seed the target repository")

    const result = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs",
      LLM4TS_CONTEXT_BUDGET: "3000"
    })

    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })

  it("feeds prior conventions.md and LLM4TS_FEEDBACK into every pass on a refine re-run", () => {
    const fixture = makeFixture()
    const feedbackMarker = "the design-system lives under src/ui, look there"
    const responder = `(prompt) => {
      if (prompt.includes("Candidate file paths (")) {
        if (prompt.includes("previous run")) {
          if (!prompt.includes("${feedbackMarker}")) {
            console.error("expected the selection prompt to carry the feedback text")
            process.exit(9)
          }
          if (!prompt.includes("Findings for Tech Stack & Dependencies")) {
            console.error("expected the selection prompt to carry the prior conventions.md")
            process.exit(9)
          }
        }
        return JSON.stringify({
          selections: [{ category: "Tech Stack & Dependencies", path: "package.json", reason: "manifest" }]
        })
      }
      const heading = (prompt.match(/## ([^"]+)"/) ?? [])[1] ?? "Unknown"
      if (heading !== "Unknown" && prompt.includes("previous run")) {
        if (!prompt.includes("${feedbackMarker}")) {
          console.error("expected the pass prompt to carry the feedback text")
          process.exit(9)
        }
      }
      return JSON.stringify({ markdown: "## " + heading + "\\n\\nFindings for " + heading + "." })
    }`
    installStub(fixture, stubProgram(responder))
    initRepo(fixture.target)
    write(fixture.target, "package.json", targetPackageJson)
    commitAll(fixture.target, "seed the target repository")

    const first = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs"
    })
    assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`)

    const second = runFlow(fixture, "pack-fork", fixture.target, {
      LLM4TS_TARGET_KIND: "frontend",
      LLM4TS_FORK_AS: "acmecorp-nextjs",
      LLM4TS_FEEDBACK: feedbackMarker
    })
    assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`)
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
