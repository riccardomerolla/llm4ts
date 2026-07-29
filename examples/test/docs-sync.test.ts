import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { completeAndPublish } from "@llm4ts/flow/Flow"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), "utf8")

const repoFileExists = (relativePath: string): boolean => {
  try {
    readRepoFile(relativePath)
    return true
  } catch {
    return false
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Scopes the search to the section between `heading` and the next heading of
 * any level, so a renamed heading, reordered blocks, or an earlier ```ts
 * fence elsewhere in the doc fails loudly instead of silently matching the
 * wrong block.
 */
const extractTsCodeBlockUnderHeading = (markdown: string, heading: string): string => {
  const headingMatch = new RegExp(`^${escapeRegExp(heading)}$`, "m").exec(markdown)
  if (headingMatch === null) {
    assert.fail(`heading "${heading}" not found in docs/flow-authoring.md`)
  }
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length)
  const nextHeadingMatch = /^#{1,6} /m.exec(rest)
  const section = nextHeadingMatch === null ? rest : rest.slice(0, nextHeadingMatch.index)

  const codeBlockMatch = /```ts\n([\s\S]*?)```/.exec(section)
  if (codeBlockMatch === null) {
    assert.fail(
      `no \`\`\`ts code block found directly under "${heading}" (before the next heading)`
    )
  }
  return codeBlockMatch[1].trimEnd()
}

describe("docs/flow-authoring.md stays in sync with the codebase", () => {
  const doc = readRepoFile("docs/flow-authoring.md")

  it("Rung 1 code block matches examples/basic.ts verbatim", () => {
    const snippet = extractTsCodeBlockUnderHeading(doc, "## Rung 1: a one-shot prompt flow")
    const source = readRepoFile("examples/basic.ts")
    assert.strictEqual(snippet, source.trimEnd())
  })

  it("completeAndPublish snippet keeps the documented call shape", () => {
    const snippet = extractTsCodeBlockUnderHeading(
      doc,
      "### The shorter equivalent: `completeAndPublish`"
    )
    assert.match(
      snippet,
      /completeAndPublish\(\s*context\.coder,\s*context\.events,\s*prompt\s*\)/,
      "docs/flow-authoring.md no longer calls completeAndPublish(context.coder, context.events, prompt) — update the doc if the call shape changed intentionally"
    )

    // Compile-time half of this check: if completeAndPublish's arity, argument
    // order, or parameter types change, `pnpm typecheck` fails right here,
    // not just this assertion.
    const callsWithDocumentedShape = (context: FlowContextShape, prompt: string) =>
      completeAndPublish(context.coder, context.events, prompt)
    assert.isFunction(callsWithDocumentedShape)
  })

  it("references only files and anchors that exist", () => {
    const referencedFiles = [
      "README.md",
      "docs/api.md",
      "docs/architecture.md",
      "docs/provider-capabilities.md",
      "examples/README.md",
      "examples/api-provider.ts",
      "examples/support.ts"
    ]
    for (const relativePath of referencedFiles) {
      assert.isTrue(
        repoFileExists(relativePath),
        `${relativePath} referenced by the doc is missing`
      )
    }

    assert.include(
      readRepoFile("README.md"),
      "## Try it in one minute",
      "README.md#try-it-in-one-minute points at a heading that no longer exists"
    )
  })

  it("references only exports that exist in examples/support.ts", () => {
    const supportSource = readRepoFile("examples/support.ts")
    const referencedExports = [
      "resolveExampleInput",
      "apiConnectorFromEnvironment",
      "runExampleMain"
    ]
    for (const exportName of referencedExports) {
      assert.include(
        supportSource,
        exportName,
        `examples/support.ts no longer exports "${exportName}", referenced by docs/flow-authoring.md`
      )
    }
  })
})
