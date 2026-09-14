import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import {
  apiConnectorFromEnvironment,
  completeAndPublish,
  loadPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  type FlowContextShape
} from "@llm4ts/runner"

/**
 * docs/guide/ is the newcomer's on-ramp; its code blocks are copied, not
 * read, so each one is pinned to the source it claims to be or to the
 * exports it names. Whitespace-insensitive where prettier and dedenting
 * differ; content is the contract.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const guideDir = join(repositoryRoot, "docs", "guide")

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8")

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const codeBlockUnderHeading = (markdown: string, heading: string, language: string): string => {
  const headingMatch = new RegExp(`^${escapeRegExp(heading)}$`, "m").exec(markdown)
  if (headingMatch === null) {
    assert.fail(`heading "${heading}" not found`)
  }
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length)
  // The section ends at the next heading OUTSIDE a fence: a manifest block
  // legitimately contains `# Pack:` and `## Gates` lines of its own.
  const lines = rest.split("\n")
  const section: Array<string> = []
  let inFence = false
  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence
    } else if (!inFence && /^#{1,6} /.test(line)) {
      break
    }
    section.push(line)
  }
  const block = new RegExp("```" + language + "\\n([\\s\\S]*?)```").exec(section.join("\n"))
  if (block === null) {
    assert.fail(`no \`\`\`${language} block under "${heading}"`)
  }
  return block[1].trimEnd()
}

const chapters = readdirSync(guideDir).filter((entry) => entry.endsWith(".md"))

describe("docs/guide stays in sync with the codebase", () => {
  it("ships the seven files the index promises", () => {
    assert.deepStrictEqual(chapters.sort(), [
      "01-install.md",
      "02-run-a-flow.md",
      "03-your-first-flow.md",
      "04-fork-a-built-in.md",
      "05-your-first-pack.md",
      "06-troubleshooting.md",
      "README.md"
    ])
  })

  it("every relative link resolves to an existing file", () => {
    for (const chapter of chapters) {
      const markdown = readFileSync(join(guideDir, chapter), "utf8")
      for (const match of markdown.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = match[1] ?? ""
        if (/^[a-z]+:/.test(target)) {
          continue
        }
        assert.isTrue(
          existsSync(resolve(guideDir, target)),
          `${chapter} links to ${target}, which does not exist`
        )
      }
    }
  })

  it("chapter 4's code block is flows/implement.ts verbatim", () => {
    const block = codeBlockUnderHeading(
      readRepoFile("docs/guide/04-fork-a-built-in.md"),
      "# 4. Fork a built-in",
      "ts"
    )
    assert.strictEqual(block, readRepoFile("flows/implement.ts").trimEnd())
  })

  it("chapter 3's hello flow is flows/hello.ts verbatim", () => {
    const block = codeBlockUnderHeading(
      readRepoFile("docs/guide/03-your-first-flow.md"),
      "## Copy it into your project",
      "ts"
    )
    assert.strictEqual(block, readRepoFile("flows/hello.ts").trimEnd())
  })

  it("the names the hello flow imports are on the @llm4ts/runner barrel, with the documented shapes", () => {
    const barrel = readRepoFile("packages/runner/src/index.ts")
    for (const name of [
      "apiConnectorFromEnvironment",
      "coderFromEnv",
      "completeAndPublish",
      "resolveFlowInput",
      "runFlowMain",
      "runNode"
    ]) {
      assert.match(
        barrel,
        new RegExp(`\\b${name}\\b`),
        `@llm4ts/runner no longer re-exports ${name}, used by docs/guide/03-your-first-flow.md`
      )
    }
    // Compile-time half: the hello flow's call shapes, as the chapter shows them.
    const documentedShape = Effect.gen(function* () {
      const input = yield* resolveFlowInput("Say hello and name one thing you can do.")
      const coder = yield* apiConnectorFromEnvironment()
      yield* runNode(
        {
          workDir: input.workDir,
          workspace: input.workspace,
          userPrompt: input.prompt,
          coder,
          environment: process.env
        },
        (context: FlowContextShape) =>
          completeAndPublish(context.coder, context.events, input.prompt)
      )
    })
    assert.isFunction(runFlowMain)
    assert.isObject(documentedShape)
  })

  it.effect("chapter 5's manifest loads as a pack with the rules it shows", () =>
    Effect.gen(function* () {
      const block = codeBlockUnderHeading(
        readRepoFile("docs/guide/05-your-first-pack.md"),
        "## The manifest",
        "md"
      )
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write("packs/my-pack/pack.md", `${block}\n`)
      const pack = yield* loadPack(workspace, "packs/my-pack")
      assert.strictEqual(pack.name, "my-pack")
      assert.strictEqual(pack.source, "jsp")
      assert.deepStrictEqual(pack.gate("test"), ["pnpm", "test"])
      assert.deepStrictEqual(
        pack.judgeDimensions.map((dimension) => dimension.name),
        ["completeness", "faithfulness"]
      )
      assert.deepStrictEqual(
        pack.coverage.map((rule) => rule.name),
        ["jsp-form"]
      )
      assert.deepStrictEqual(
        pack.survey.map((rule) => rule.name),
        ["jsp-include"]
      )
    })
  )

  it("the commands the guide names exist", () => {
    assert.isTrue(existsSync(join(repositoryRoot, "flows", "modernize-pack-check.ts")))
    assert.isTrue(existsSync(join(repositoryRoot, "flows", "hello.ts")))
    assert.isTrue(existsSync(join(repositoryRoot, "flows", "sdd.ts")))
    assert.isTrue(existsSync(join(repositoryRoot, "examples", "seed.sh")))
    const cli = readRepoFile("packages/shell/src/Cli.ts")
    for (const command of ['"run"', '"list"', '"kits"', '"view"', '"ask"', '"doctor"']) {
      assert.include(cli, command, `the shell no longer defines ${command}`)
    }
  })
})
