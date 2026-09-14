import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"

/**
 * The two authoring skills are self-contained by design — an agent running
 * them has no llm4ts checkout to read — so their embedded templates are the
 * API surface they carry. This pins each template to the guide chapter it
 * mirrors and proves it against the real code: the hello flow is run through
 * the shell's own resolve fallback against the mock provider, and the pack
 * template is loaded by the real pack loader.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8")

const stripWhitespace = (text: string): string => text.replace(/\s+/g, "")

const firstBlock = (markdown: string, language: string): string => {
  const block = new RegExp("```" + language + "\\n([\\s\\S]*?)```").exec(markdown)
  if (block === null) {
    assert.fail(`no \`\`\`${language} block found`)
  }
  return block[1].trimEnd()
}

const Marketplace = Schema.Struct({
  plugins: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String }))
})

describe("skills stay in sync with the guide and the codebase", () => {
  const flowSkill = readRepoFile("skills/authoring-llm4ts-flows/SKILL.md")
  const packSkill = readRepoFile("skills/authoring-llm4ts-packs/SKILL.md")
  const packTemplate = readRepoFile("skills/authoring-llm4ts-packs/references/pack-template.md")

  it("both skills are registered in the marketplace with matching front matter", () => {
    const marketplace = Schema.decodeUnknownSync(Schema.fromJsonString(Marketplace))(
      readRepoFile(".claude-plugin/marketplace.json")
    )
    for (const name of ["using-llm4ts", "authoring-llm4ts-flows", "authoring-llm4ts-packs"]) {
      const entry = marketplace.plugins.find((plugin) => plugin.name === name)
      assert.isDefined(entry, `${name} is not registered in .claude-plugin/marketplace.json`)
      assert.strictEqual(entry.source, `./skills/${name}`)
      const skill = readRepoFile(`skills/${name}/SKILL.md`)
      assert.match(skill, new RegExp(`^name: ${name}$`, "m"), `${name}/SKILL.md front matter`)
      assert.isTrue(
        existsSync(join(repositoryRoot, "skills", name, ".claude-plugin", "plugin.json"))
      )
      assert.isTrue(existsSync(join(repositoryRoot, "skills", name, "README.md")))
    }
  })

  it("the flow skill's hello template is the built-in flows/hello.ts", () => {
    const template = firstBlock(flowSkill, "ts")
    assert.strictEqual(stripWhitespace(template), stripWhitespace(readRepoFile("flows/hello.ts")))
  })

  it("the flow skill's hello template runs zero-install against the mock provider", () => {
    const template = firstBlock(flowSkill, "ts")
    const project = mkdtempSync(join(tmpdir(), "llm4ts-skill-hello-"))
    mkdirSync(join(project, ".llm4ts", "flows"), { recursive: true })
    const flowPath = join(project, ".llm4ts", "flows", "hello.ts")
    writeFileSync(flowPath, `${template}\n`)
    // The same launch the shell performs for a project-tier flow: type
    // stripping plus the resolve fallback that anchors bare `@llm4ts/*` and
    // `effect` imports at the shell's installation when the project has none.
    const fallback = pathToFileURL(
      join(repositoryRoot, "packages", "shell", "src", "ResolveFallback.ts")
    ).href
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--import", fallback, flowPath, "What is llm4ts?"],
      {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, LLM4TS_PROVIDER: "mock", LLM4TS_VERBOSITY: "quiet" }
      }
    )
    assert.strictEqual(
      result.status,
      0,
      `hello flow exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    )
    assert.include(result.stdout, "mock response")
  })

  it("the pack skill's template is chapter 5's manifest", () => {
    const template = firstBlock(packTemplate, "md")
    const chapter = readRepoFile("docs/guide/05-your-first-pack.md")
    assert.strictEqual(stripWhitespace(template), stripWhitespace(firstBlock(chapter, "md")))
  })

  it.effect("the pack skill's template loads with the real pack loader", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write("packs/my-pack/pack.md", `${firstBlock(packTemplate, "md")}\n`)
      const pack = yield* loadPack(workspace, "packs/my-pack")
      assert.strictEqual(pack.name, "my-pack")
      assert.lengthOf(pack.coverage, 1)
      assert.lengthOf(pack.survey, 1)
    })
  )

  it("the pack skill names only sidecars and the check flow that exist", () => {
    assert.isTrue(existsSync(join(repositoryRoot, "flows", "modernize-pack-check.ts")))
    assert.include(packSkill, "modernize-pack-check")
    const reference = readRepoFile("skills/authoring-llm4ts-packs/references/manifest.md")
    const packSource = readRepoFile("packages/flow/src/Pack.ts")
    for (const field of [
      "source",
      "sources",
      "exclude",
      "programs",
      "scaffold",
      "specs-dir",
      "features-dir",
      "replay",
      "programFiles"
    ]) {
      assert.include(reference, `\`${field}\``, `manifest.md no longer documents ${field}`)
      assert.include(
        packSource,
        field,
        `Pack.ts no longer reads '${field}', documented by manifest.md`
      )
    }
  })
})
