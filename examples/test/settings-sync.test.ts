import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { closestSettingName, isSettingName, settingNames } from "@llm4ts/flow/Settings"

/**
 * The registry is only worth trusting while it names exactly what the code
 * reads. This scans everything llm4ts ships or runs for `LLM4TS_*` tokens:
 * a token the registry lacks is a setting nobody can discover, and a registry
 * name no code mentions is a row that documents nothing.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const registryFile = "packages/flow/src/settings/Registry.ts"
const skippedDirectories = new Set(["node_modules", "dist", "test", "tests", "fixtures", ".llm4ts"])
const textFile = /\.(?:[cm]?[jt]sx?|md|sh|json|ya?ml|txt)$/u
const prose = /\.(?:md|txt)$/u

const walk = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : walk(path)
    }
    return textFile.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : []
  })

// Build copies (packages/shell/flows, packages/shell/kits) sit outside src, so they are never walked.
const scannedFiles = [
  ...readdirSync(join(repositoryRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => walk(`packages/${entry.name}/src`)),
  ...walk("flows"),
  ...walk("kits"),
  ...walk("examples"),
  ...walk("tools/judgment")
].filter((file) => file !== registryFile)

interface Mention {
  readonly name: string
  readonly file: string
  readonly line: number
}

const mentions: ReadonlyArray<Mention> = scannedFiles.flatMap((file) =>
  readFileSync(join(repositoryRoot, file), "utf8")
    .split("\n")
    .flatMap((text, index) =>
      [...text.matchAll(/LLM4TS_[A-Z0-9_]+/gu)].map(([name]) => ({ name, file, line: index + 1 }))
    )
)

describe("the settings registry stays in sync with the code", () => {
  it("scans the tree it claims to", () => {
    assert.isAbove(scannedFiles.length, 100)
    assert.include(scannedFiles, "packages/runner/src/FlowRunner.ts")
    assert.include(scannedFiles, "flows/lib/epic-stories.ts")
    assert.include(scannedFiles, "kits/j2ee-nextjs/flows/convert-all.ts")
    assert.include(scannedFiles, "tools/judgment/lib.ts")
    assert.isEmpty(scannedFiles.filter((file) => /^packages\/shell\/(?:flows|kits)\//u.test(file)))
  })

  it("every LLM4TS_* name in the code is a registry name", () => {
    const unknown = mentions
      .filter((mention) => !isSettingName(mention.name))
      .map((mention) => {
        const closest = closestSettingName(mention.name)
        return (
          `${mention.file}:${mention.line} ${mention.name} is not a setting` +
          (closest === undefined ? "" : ` (did you mean ${closest}?)`)
        )
      })
    assert.deepStrictEqual(
      unknown,
      [],
      `add each name to ${registryFile}, or fix the text that names it:\n${unknown.join("\n")}\n`
    )
  })

  it("every registry name is mentioned by code, not only by prose", () => {
    const inCode = new Set(
      mentions.filter((mention) => !prose.test(mention.file)).map((mention) => mention.name)
    )
    const dead = settingNames.filter((name) => !inCode.has(name))
    assert.deepStrictEqual(
      dead,
      [],
      `no code under packages/*/src, flows, kits, examples or tools/judgment mentions these; remove them from ${registryFile}:\n${dead.join("\n")}\n`
    )
  })
})
