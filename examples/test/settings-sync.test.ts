import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import {
  closestSettingName,
  isSettingName,
  settingFacts,
  settingNames,
  settingsReference
} from "@llm4ts/flow/Settings"

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

/**
 * A setting is read through `settingValue`, `settingGiven` or `settingText`,
 * so its grammar and default are the registry's (ADR 0049). A raw read is
 * `<object>.LLM4TS_X` or `<object>["LLM4TS_X"]` in production code outside
 * the registry itself; no area has one left. A helper that takes the name as
 * a string and reads it by hand is the same read in disguise, so a quoted
 * setting name may only be the argument of a registry reader.
 */
const rawRead = /\.LLM4TS_[A-Z0-9_]+|\[\s*["'`]LLM4TS_[A-Z0-9_]+["'`]\s*\]/gu
const registryCode = /^packages\/flow\/src\/(?:Settings\.ts$|settings\/)/u
const areas = ["packages", "flows", "kits", "examples", "tools"] as const

const rawReadsIn = (text: string): number => [...text.matchAll(rawRead)].length

/** `namedSeat` is the runner's seat resolver: it takes a `SettingName` and reads it with `settingText`. */
const registryReaders = new Set(["settingValue", "settingGiven", "settingText", "namedSeat"])
const namedInCall = /([A-Za-z_$][\w$]*)\(\s*(?:[\w$.]+\s*,\s*)?["'`]LLM4TS_[A-Z0-9_]+["'`]\s*[,)]/gu

const readsByNameIn = (text: string): number =>
  [...text.matchAll(namedInCall)].filter(([, callee]) => !registryReaders.has(callee ?? "")).length

const linesWith = (
  area: (typeof areas)[number],
  count: (text: string) => number
): ReadonlyArray<string> =>
  scannedFiles
    .filter(
      (file) =>
        file.startsWith(`${area}/`) && /\.[cm]?[jt]sx?$/u.test(file) && !registryCode.test(file)
    )
    .flatMap((file) =>
      readFileSync(join(repositoryRoot, file), "utf8")
        .split("\n")
        .flatMap((text, index) =>
          Array.from({ length: count(text) }, () => `${file}:${index + 1} ${text.trim()}`)
        )
    )

describe("settings are read through the registry", () => {
  it("counts member and bracket reads, not writes of an environment or lists of names", () => {
    assert.strictEqual(rawReadsIn("const a = environment.LLM4TS_PACK?.trim()"), 1)
    assert.strictEqual(rawReadsIn('process.env["LLM4TS_RUN_ID"] ?? env.LLM4TS_FLOW'), 2)
    assert.strictEqual(rawReadsIn('settingValue("LLM4TS_PACK", environment)'), 0)
    assert.strictEqual(rawReadsIn('launch({ LLM4TS_REGROUP: "1" })'), 0)
    assert.strictEqual(rawReadsIn('const seats = ["LLM4TS_CODER", "LLM4TS_REASONER"]'), 0)
  })

  it("counts a helper handed a setting name, not a registry reader", () => {
    assert.strictEqual(readsByNameIn('positiveEnvInt("LLM4TS_ANALYST_TURNS", 48)'), 1)
    assert.strictEqual(readsByNameIn('positiveEnvInt(environment, "LLM4TS_JUDGE_ROUNDS", 2)'), 1)
    assert.strictEqual(readsByNameIn('settingValue("LLM4TS_PACK", environment) ?? fallback'), 0)
    assert.strictEqual(readsByNameIn('settingGiven("LLM4TS_GATES", process.env)._tag'), 0)
    assert.strictEqual(readsByNameIn('yield* namedSeat("LLM4TS_CODER", environment)'), 0)
    assert.strictEqual(readsByNameIn('const seats = ["LLM4TS_CODER", "LLM4TS_REASONER"]'), 0)
    assert.strictEqual(readsByNameIn('Info.make({ message: "LLM4TS_GRAPH_REFINE=off" })'), 0)
  })

  for (const area of areas) {
    it(`${area}: no raw LLM4TS_* read`, () => {
      const found = linesWith(area, rawReadsIn)
      assert.deepStrictEqual(
        found,
        [],
        `read these through settingValue from @llm4ts/flow/Settings:\n${found.join("\n")}\n`
      )
    })

    it(`${area}: no helper reads a setting by its name`, () => {
      const found = linesWith(area, readsByNameIn)
      assert.deepStrictEqual(
        found,
        [],
        `call settingValue, settingGiven or settingText with the name instead:\n${found.join("\n")}\n`
      )
    })
  }
})

/**
 * The documentation a user reads today. The frozen records (`plan.md`,
 * `docs/csp/`, `docs/CSP_STATUS.md`, `docs/parity.md`), the ADRs, the research
 * notes and the changelog describe the past and are left out.
 */
const frozenDocs = new Set(["docs/CSP_STATUS.md", "docs/parity.md"])

const named = (directory: string, keep: (name: string) => boolean): ReadonlyArray<string> =>
  readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : named(path, keep)
    }
    return keep(entry.name) ? [path] : []
  })

const markdownIn = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(repositoryRoot, directory))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `${directory}/${name}`)

const isRunbook = (name: string): boolean => name === "README.md" || name === "RUNBOOK.md"

const liveDocs = [
  "README.md",
  ...markdownIn("docs").filter((file) => !frozenDocs.has(file)),
  ...markdownIn("docs/guide"),
  "flows/README.md",
  ...named("kits", isRunbook),
  ...named("examples", isRunbook),
  ...named("skills", (name) => name.endsWith(".md")),
  ...named(".claude/skills", (name) => name.endsWith(".md"))
]

const linesOf = (file: string): ReadonlyArray<string> =>
  readFileSync(join(repositoryRoot, file), "utf8").split("\n")

/** Misspelled on purpose: the input of a typo-warning check, never a setting. */
const deliberateMisspellings: Readonly<Record<string, ReadonlyArray<string>>> = {
  ".claude/skills/verify-llm4ts/features/config.md": ["LLM4TS_VERBOSTY"]
}

const referenceDoc = "docs/configuration.md"
const referenceScript = "scripts/settings-docs.mjs"

describe("the documentation stays in sync with the settings registry", () => {
  it("reads the documents it claims to", () => {
    assert.isAbove(liveDocs.length, 40)
    for (const file of [
      referenceDoc,
      "docs/flow-authoring.md",
      "kits/j2ee-nextjs/fixtures/demo-bank/RUNBOOK.md",
      "kits/soap-ace/README.md",
      "docs/guide/01-install.md",
      "examples/internet-banking/RUNBOOK.md",
      "skills/using-llm4ts/SKILL.md",
      ".claude/skills/verify-llm4ts/SKILL.md"
    ]) {
      assert.include(liveDocs, file)
    }
    assert.isEmpty(liveDocs.filter((file) => frozenDocs.has(file) || file.startsWith("docs/adr/")))
  })

  it("the settings reference in docs/configuration.md is the registry's", () => {
    const text = readFileSync(join(repositoryRoot, referenceDoc), "utf8")
    const begin = "<!-- settings:begin -->"
    const from = text.indexOf(begin)
    const to = text.indexOf("<!-- settings:end -->")
    assert.isTrue(from >= 0 && to > from, `${referenceDoc} lost its settings:begin and :end lines`)
    assert.strictEqual(
      text.slice(from + begin.length, to).trim(),
      settingsReference(),
      `${referenceDoc} differs from the registry: run \`node ${referenceScript}\`, never edit the region by hand`
    )
  })

  it("every LLM4TS_* name in the live docs is a registry name", () => {
    const unknown = liveDocs.flatMap((file) =>
      linesOf(file).flatMap((text, index) =>
        [...text.matchAll(/LLM4TS_[A-Z0-9_]+/gu)]
          .map(([name]) => name)
          .filter(
            (name) => !isSettingName(name) && !(deliberateMisspellings[file] ?? []).includes(name)
          )
          .map((name) => {
            const closest = closestSettingName(name)
            return (
              `${file}:${index + 1} ${name} is not a setting` +
              (closest === undefined ? "" : ` (did you mean ${closest}?)`)
            )
          })
      )
    )
    assert.deepStrictEqual(unknown, [], `fix the text that names it:\n${unknown.join("\n")}\n`)
  })

  it("every registry flag is an `llm4ts run` flag that forwards that setting", () => {
    const cli = readFileSync(join(repositoryRoot, "packages/shell/src/Cli.ts"), "utf8")
    const run = cli.slice(cli.indexOf("const runCommand = Command.make("))
    const runFlags = run.slice(0, run.indexOf("(config) =>"))
    assert.isAbove(runFlags.length, 500, "the run command's flags were not found in Cli.ts")
    const broken = settingNames.flatMap((name) => {
      const flag = settingFacts(name).flag
      if (flag === undefined) {
        return []
      }
      const declared = new RegExp(`Flag\\.\\w+\\("${flag.slice(2)}"`, "u").test(runFlags)
      const forwarded = new RegExp(`name: "${name}",[^}]*flag: "${flag}"`, "u").test(cli)
      return declared && forwarded ? [] : [`${name}: ${flag}`]
    })
    assert.deepStrictEqual(broken, [], "llm4ts run has no such flag, or it sets another setting")
  })

  it("every flow a setting is required by exists", () => {
    const flowFiles = [
      ...readdirSync(join(repositoryRoot, "flows")),
      ...readdirSync(join(repositoryRoot, "kits")).flatMap((kit) =>
        existsSync(join(repositoryRoot, "kits", kit, "flows"))
          ? readdirSync(join(repositoryRoot, "kits", kit, "flows"))
          : []
      )
    ]
    const missing = settingNames.flatMap((name) =>
      settingFacts(name)
        .requiredBy.filter((flow) => !flowFiles.includes(`${flow}.ts`))
        .map((flow) => `${name}: ${flow}`)
    )
    assert.deepStrictEqual(missing, [], "no flows/<flow>.ts or kits/<kit>/flows/<flow>.ts")
  })
})

/**
 * A runbook command needs no `LLM4TS_…=` in front of it: a value that holds
 * for a repository or a machine is written once with `llm4ts config set`, and
 * a value for one run goes in `--set NAME=value` or a flag. Two kinds of
 * assignment stay:
 *
 * - a setting of the `secret` scope, which no file and no flag may carry;
 * - a fence whose nearest line above is the marker
 *   `<!-- settings:env-prefix <reason> -->`. It is for a command that starts
 *   a flow script with `node` or `pnpm --filter`, which reads only the
 *   environment. `grep -rn "settings:env-prefix"` lists every exemption.
 */
const exemptionMarker = /^<!-- settings:env-prefix \S.* -->$/u
const shellFences = new Set(["", "sh", "bash", "shell", "zsh", "console"])
const commandStart = /(?:^|&&|\|\||[;|(])\s*(?:\$\s+)?(?:(?:export|env)\s+)?/gu
const assignment = /\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|]*)/uy

/** The variables a shell line assigns in front of a command or after `export`. */
const assignedIn = (command: string): ReadonlyArray<string> =>
  [...command.matchAll(commandStart)].flatMap((start) => {
    const names: Array<string> = []
    assignment.lastIndex = start.index + start[0].length
    for (let match = assignment.exec(command); match !== null; match = assignment.exec(command)) {
      names.push(match[1] ?? "")
    }
    return names
  })

interface Prefixed {
  readonly line: number
  readonly names: ReadonlyArray<string>
}

/** Every line of a shell fence that assigns an `LLM4TS_*` variable, exempt fences left out. */
const prefixedCommands = (lines: ReadonlyArray<string>): ReadonlyArray<Prefixed> => {
  const found: Array<Prefixed> = []
  let fence: { readonly shell: boolean } | undefined
  let above = ""
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? ""
    const edge = /^\s*(?:`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/u.exec(text)
    if (edge !== null) {
      fence =
        fence === undefined
          ? { shell: shellFences.has(edge[1] ?? "") && !exemptionMarker.test(above) }
          : undefined
      above = ""
      continue
    }
    if (fence === undefined) {
      above = text.trim().length === 0 ? above : text.trim()
      continue
    }
    if (!fence.shell) {
      continue
    }
    const line = index + 1
    let command = text
    while (command.endsWith("\\") && !/^\s*(?:`{3,}|~{3,})/u.test(lines[index + 1] ?? "```")) {
      index += 1
      command = `${command.slice(0, -1)} ${(lines[index] ?? "").trim()}`
    }
    const names = assignedIn(command).filter(
      (name) =>
        name.startsWith("LLM4TS_") &&
        !(isSettingName(name) && settingFacts(name).scope === "secret")
    )
    if (names.length > 0) {
      found.push({ line, names })
    }
  }
  return found
}

describe("the live docs carry no LLM4TS_ prefix in front of a command", () => {
  it("finds a prefix, an export and a continued line, and honours both exemptions", () => {
    const sample = [
      "```sh",
      "LLM4TS_CODER=codex llm4ts run implement",
      "export LLM4TS_PACK=x   # comment",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:1234 \\",
      "LLM4TS_CODER=claude \\",
      "  llm4ts run epic-stories",
      "cd repo && LLM4TS_WAVE=wave-1 llm4ts run modernize-extract",
      "export LLM4TS_MCP_TOKEN=$(pass show llm4ts)",
      "llm4ts config set LLM4TS_CODER=pi",
      "llm4ts run sdd --set LLM4TS_CODER_MODEL=x \\",
      "  LLM4TS_NOT_A_PREFIX=1",
      "# LLM4TS_CODER=codex in a comment",
      "```",
      "",
      "```dotenv",
      "LLM4TS_CODER=pi",
      "```",
      "",
      "<!-- settings:env-prefix a script started this way reads only the environment -->",
      "",
      "```sh",
      "LLM4TS_CODER=codex pnpm --filter @llm4ts/flows implement",
      "```"
    ]
    assert.deepStrictEqual(prefixedCommands(sample), [
      { line: 2, names: ["LLM4TS_CODER"] },
      { line: 3, names: ["LLM4TS_PACK"] },
      { line: 4, names: ["LLM4TS_CODER"] },
      { line: 7, names: ["LLM4TS_WAVE"] }
    ])
  })

  it("no shell fence of the live docs assigns a setting in front of a command", () => {
    const prefixed = liveDocs.flatMap((file) =>
      prefixedCommands(linesOf(file)).map(
        ({ line, names }) => `${file}:${line} assigns ${names.join(", ")}`
      )
    )
    assert.deepStrictEqual(
      prefixed,
      [],
      "write the value once with `llm4ts config set`, or pass `--set NAME=value`, `--coder` or the " +
        "setting's flag on `llm4ts run`; a script that reads only the environment keeps its prefix " +
        `under a \`<!-- settings:env-prefix <reason> -->\` line:\n${prefixed.join("\n")}\n`
    )
  })
})
