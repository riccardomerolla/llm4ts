import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import { makeProcessExecutor, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { Environment } from "@llm4ts/flow/Settings"
import { globalConfigPath, projectConfigPath, registryFacts } from "@llm4ts/shell/Config"
import {
  acceptProject,
  configView,
  renderDoctorConfig,
  renderTrustListing,
  reviewProject,
  runConfigInit,
  runConfigSet,
  runConfigShow,
  runConfigUnset,
  runConfigUntrust,
  trustStep,
  type ConfigDeps,
  type ProjectReview,
  type SeatAnswers
} from "@llm4ts/shell/ConfigCommand"
import { configTrustPath, contentHash } from "@llm4ts/shell/ConfigTrust"

const home = "/home/u"
const repo = "/home/u/demo/nextjs"
const cwd = "/home/u/work"
const projectPath = projectConfigPath(repo)
const globalPath = globalConfigPath({ HOME: home })
const trustPath = configTrustPath({ HOME: home })

const git = makeProcessExecutor({
  run: (argv) =>
    argv[0] === "git"
      ? Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 }))
      : Effect.fail(ProviderError.make({ message: "unexpected command" })),
  runStreaming: () => Stream.empty
})

const trustList = (records: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(records).map(([at, text]) => [at, contentHash(text)]))
  )

/** A project file in `files` is trusted as it stands unless `trust` is `false`. */
const world = (options: {
  readonly files?: Readonly<Record<string, string>>
  readonly environment?: Environment
  readonly trust?: false
}) =>
  Effect.gen(function* () {
    const held = options.files ?? {}
    const project = held[projectPath]
    const memory = yield* makeMemoryPlainFileStore(
      project === undefined || options.trust === false
        ? held
        : { ...held, [trustPath]: trustList({ [repo]: project }) }
    )
    const deps: ConfigDeps = {
      files: memory.store,
      executor: git,
      environment: { HOME: home, ...options.environment },
      cwd
    }
    return { memory, deps }
  })

const trustOf = (files: Readonly<Record<string, string>>): unknown =>
  JSON.parse(files[trustPath] ?? "{}")

const untrustedLine = `${projectPath} is new and not trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
const writeRefused = `${projectPath} is new and not trusted, so llm4ts writes nothing to it. Review and accept it first: llm4ts config trust --repo ${repo}`

const demo = {
  files: {
    [globalPath]: "LLM4TS_CODER=pi\nLLM4TS_REASONER=claude\n",
    [projectPath]: [
      "# the demo",
      "LLM4TS_PACK=j2ee-nextjs-spa",
      "LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee",
      "LLM4TS_JUDGE_ROUNDS=1",
      "LLM4TS_ADO_ORG_URL=https://dev.azure.com/acme",
      ""
    ].join("\n")
  },
  environment: {
    LLM4TS_PACK: "cobol-springboot",
    LLM4TS_GEMINI_BRIDGE_TOKEN: "t0ken-never-shown",
    LLM4TS_EXTRACT_CONCURENCY: "3",
    LLM4TS_STALL_MINUTES: "soon",
    LLM4TS_MY_FLOW_KNOB: "1",
    ANTHROPIC_API_KEY: "sk-never-shown",
    GEMINI_API_KEY: ""
  }
}

const atDefault = registryFacts.length - 8

describe("config show", () => {
  it.effect("lists the files, each set setting with its source, credentials and warnings", () =>
    Effect.gen(function* () {
      const { deps } = yield* world(demo)
      const shown = yield* runConfigShow(deps, { repo, all: false, json: false })
      assert.strictEqual(
        shown,
        [
          "files",
          "  global    ~/.config/llm4ts/config.env        2 settings",
          "  project   ~/demo/nextjs/.llm4ts/config.env   4 settings",
          "",
          "setting                      value                        from",
          "LLM4TS_CODER                 pi                           global:1",
          "LLM4TS_REASONER              claude                       global:2",
          "LLM4TS_PACK                  cobol-springboot             environment   (project:2 has j2ee-nextjs-spa)",
          "LLM4TS_LEGACY_REPO           /home/u/demo/legacy-j2ee     project:3",
          "LLM4TS_JUDGE_ROUNDS          1                            project:4",
          "LLM4TS_STALL_MINUTES         soon                         environment",
          "LLM4TS_ADO_ORG_URL           https://dev.azure.com/acme   project:5",
          "LLM4TS_GEMINI_BRIDGE_TOKEN   (secret, set)                environment",
          "",
          "credentials",
          "  ANTHROPIC_API_KEY   set",
          "  OPENAI_API_KEY      unset",
          "  GEMINI_API_KEY      unset",
          "  GOOGLE_API_KEY      unset",
          "  TYPESAFE_API_KEY    unset",
          "",
          "warnings",
          "  the environment: LLM4TS_STALL_MINUTES must be a positive number of minutes",
          "  the environment: unknown setting LLM4TS_EXTRACT_CONCURENCY; did you mean LLM4TS_EXTRACT_CONCURRENCY?",
          "  the environment: unknown setting LLM4TS_MY_FLOW_KNOB",
          "",
          `${atDefault} settings at their defaults: llm4ts config show --all · one in full: llm4ts config show <NAME>`
        ].join("\n")
      )
      assert.notInclude(shown, "never-shown")
    })
  )

  it.effect("with nothing set anywhere shows absent files and the default count", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({})
      assert.strictEqual(
        yield* runConfigShow(deps, { repo, all: false, json: false }),
        [
          "files",
          "  global    ~/.config/llm4ts/config.env        absent",
          "  project   ~/demo/nextjs/.llm4ts/config.env   absent",
          "",
          "credentials",
          "  ANTHROPIC_API_KEY   unset",
          "  OPENAI_API_KEY      unset",
          "  GEMINI_API_KEY      unset",
          "  GOOGLE_API_KEY      unset",
          "  TYPESAFE_API_KEY    unset",
          "",
          `${registryFacts.length} settings at their defaults: llm4ts config show --all · one in full: llm4ts config show <NAME>`
        ].join("\n")
      )
    })
  )

  it.effect("--all adds every setting at its default under its group's title", () =>
    Effect.gen(function* () {
      const { deps } = yield* world(demo)
      const shown = yield* runConfigShow(deps, { repo, all: true, json: false })
      const lines = shown.split("\n")
      assert.include(lines, "Seats and models")
      assert.include(lines, "Gates")
      const defaults = lines.filter((line) => /^ {2}LLM4TS_\S+ .* default$/u.test(line))
      assert.strictEqual(defaults.length, atDefault)
      assert.isTrue(
        defaults.some((line) => /^ {2}LLM4TS_VERBOSITY\s+normal\s+default$/u.test(line))
      )
      assert.strictEqual(
        lines.at(-1),
        `${atDefault} settings at their defaults · one in full: llm4ts config show <NAME>`
      )
    })
  )

  it.effect("NAME prints one setting in full", () =>
    Effect.gen(function* () {
      const { deps } = yield* world(demo)
      const fact = registryFacts.find((candidate) => candidate.name === "LLM4TS_PACK")
      assert.strictEqual(
        yield* runConfigShow(deps, { repo, name: "LLM4TS_PACK", all: false, json: false }),
        [
          "LLM4TS_PACK = cobol-springboot    from the environment",
          "  flag          —",
          "  environment   cobol-springboot",
          "  project       j2ee-nextjs-spa",
          "  global        —",
          `  default       ${fact?.fallback.text ?? ""}`,
          fact?.doc ?? "",
          `value: ${fact?.grammar ?? ""} · belongs in: the project file · group: repositories · flag: --pack`
        ].join("\n")
      )
    })
  )

  it.effect("NAME for a secret and for an unset setting", () =>
    Effect.gen(function* () {
      const { deps } = yield* world(demo)
      const secret = yield* runConfigShow(deps, {
        repo,
        name: "LLM4TS_GEMINI_BRIDGE_TOKEN",
        all: false,
        json: false
      })
      assert.include(secret, "LLM4TS_GEMINI_BRIDGE_TOKEN = (secret, set)    from the environment")
      assert.include(secret, "belongs in: the environment only")
      assert.notInclude(secret, "never-shown")
      const unset = yield* runConfigShow(deps, {
        repo,
        name: "LLM4TS_LEGACY_REPO",
        all: false,
        json: false
      })
      assert.include(
        unset,
        "LLM4TS_LEGACY_REPO = /home/u/demo/legacy-j2ee    from project ~/demo/nextjs/.llm4ts/config.env:3"
      )
      assert.include(
        unset,
        "required by: modernize-seed, convert-page, convert-all, convert-feature"
      )
      const none = yield* runConfigShow(deps, {
        repo,
        name: "LLM4TS_WAVE",
        all: false,
        json: false
      })
      assert.strictEqual(none.split("\n")[0], "LLM4TS_WAVE is at its default")
      assert.include(none, "belongs in: a run (llm4ts run --set)")
    })
  )

  it.effect("an unknown NAME is refused with the closest setting", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({})
      const error = yield* Effect.flip(
        runConfigShow(deps, { repo, name: "LLM4TS_JUDGE_ROUND", all: false, json: false })
      )
      assert.strictEqual(
        error.message,
        "unknown setting LLM4TS_JUDGE_ROUND; did you mean LLM4TS_JUDGE_ROUNDS?"
      )
    })
  )

  it.effect("--json carries every setting and never a secret", () =>
    Effect.gen(function* () {
      const { deps } = yield* world(demo)
      const text = yield* runConfigShow(deps, { repo, all: false, json: true })
      assert.notInclude(text, "never-shown")
      const parsed: {
        readonly files: ReadonlyArray<unknown>
        readonly settings: ReadonlyArray<Record<string, unknown>>
        readonly credentials: ReadonlyArray<unknown>
        readonly problems: ReadonlyArray<{ readonly kind: string }>
      } = JSON.parse(text)
      assert.strictEqual(parsed.settings.length, registryFacts.length)
      const named = (name: string) => parsed.settings.find((setting) => setting.name === name)
      assert.deepStrictEqual(named("LLM4TS_PACK"), {
        name: "LLM4TS_PACK",
        group: "repositories",
        scope: "project",
        set: true,
        source: "environment",
        value: "cobol-springboot",
        shadowed: [{ source: "project", path: projectPath, line: 2, value: "j2ee-nextjs-spa" }],
        default: named("LLM4TS_PACK")?.default,
        grammar: named("LLM4TS_PACK")?.grammar,
        doc: named("LLM4TS_PACK")?.doc
      })
      assert.deepStrictEqual(
        [named("LLM4TS_GEMINI_BRIDGE_TOKEN")?.set, named("LLM4TS_GEMINI_BRIDGE_TOKEN")?.value],
        [true, undefined]
      )
      assert.deepStrictEqual(
        [named("LLM4TS_WAVE")?.set, named("LLM4TS_WAVE")?.source],
        [false, "default"]
      )
      assert.deepStrictEqual(parsed.files, [
        { layer: "global", path: globalPath, state: "present", settings: 2 },
        { layer: "project", path: projectPath, state: "present", settings: 4 }
      ])
      assert.deepStrictEqual(parsed.credentials[0], { name: "ANTHROPIC_API_KEY", set: true })
      assert.deepStrictEqual(parsed.problems.map((problem) => problem.kind).sort(), [
        "shadowed",
        "unknown",
        "unknown",
        "unreadable"
      ])
    })
  )

  it.effect("a project file never trusted is shown as not trusted, and none of it is used", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({ ...demo, environment: {}, trust: false })
      const lines = (yield* runConfigShow(deps, { repo, all: false, json: false })).split("\n")
      assert.strictEqual(lines[2], "  project   ~/demo/nextjs/.llm4ts/config.env   not trusted")
      assert.include(lines, `  ${untrustedLine}`)
      assert.isFalse(lines.some((line) => line.startsWith("LLM4TS_PACK")))
      assert.include(
        yield* runConfigShow(deps, { repo, name: "LLM4TS_PACK", all: false, json: false }),
        "LLM4TS_PACK is at its default"
      )
    })
  )

  it.effect("a project file edited by hand after it was trusted is shown as changed", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ files: { [projectPath]: "LLM4TS_JUDGE_ROUNDS=1\n" } })
      yield* memory.store.writeAtomic(
        projectPath,
        "LLM4TS_JUDGE_ROUNDS=1\nLLM4TS_GATES=echo pwned\n"
      )
      const shown = yield* runConfigShow(deps, { repo, all: false, json: false })
      const lines = shown.split("\n")
      assert.strictEqual(
        lines[2],
        "  project   ~/demo/nextjs/.llm4ts/config.env   changed since trusted"
      )
      assert.include(
        lines,
        `  ${projectPath} has changed since it was trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
      )
      assert.notInclude(shown, "LLM4TS_JUDGE_ROUNDS")
      assert.notInclude(shown, "pwned")
      const json: unknown = JSON.parse(yield* runConfigShow(deps, { repo, all: false, json: true }))
      assert.deepNestedInclude(json, { "files[1].state": "changed", "files[1].settings": 0 })
    })
  )
})

describe("doctor's config section", () => {
  it.effect("names both files, their counts and what blocks a run", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({
        files: { [globalPath]: "LLM4TS_CODER=pi\nLLM4TS_JUDGE_ROUNDS=one\n" }
      })
      assert.strictEqual(
        renderDoctorConfig(yield* configView(deps, repo)),
        [
          "config:",
          "  ✔   global    ~/.config/llm4ts/config.env        1 setting",
          "  ·   project   ~/demo/nextjs/.llm4ts/config.env   absent",
          `  ✖ ${globalPath}:2: LLM4TS_JUDGE_ROUNDS must be a positive integer`
        ].join("\n")
      )
    })
  )
})

describe("doctor's config section, project file not trusted", () => {
  it.effect("marks the file and names the command that accepts it", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({
        files: { [projectPath]: "LLM4TS_GATES=echo pwned\n" },
        trust: false
      })
      assert.strictEqual(
        renderDoctorConfig(yield* configView(deps, repo)),
        [
          "config:",
          "  ·   global    ~/.config/llm4ts/config.env        absent",
          "  ✖   project   ~/demo/nextjs/.llm4ts/config.env   not trusted",
          `  ✖ ${untrustedLine}`
        ].join("\n")
      )
    })
  )
})

describe("config set", () => {
  it.effect("routes each name to its file, makes paths absolute and says what changed", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: {
          [globalPath]: "LLM4TS_CODER=pi\n",
          [projectPath]: "LLM4TS_JUDGE_ROUNDS=2 # stage\n"
        },
        environment: { LLM4TS_PACK: "cobol-springboot" }
      })
      assert.strictEqual(
        yield* runConfigSet(deps, {
          repo,
          pairs: [
            "LLM4TS_PACK=j2ee-nextjs-spa",
            "LLM4TS_LEGACY_REPO=../demo/legacy-j2ee",
            "LLM4TS_JUDGE_ROUNDS=1",
            "LLM4TS_CODER=pi"
          ]
        }),
        [
          "project  ~/demo/nextjs/.llm4ts/config.env",
          "  LLM4TS_PACK=j2ee-nextjs-spa                   new",
          "  LLM4TS_LEGACY_REPO=/home/u/demo/legacy-j2ee   new",
          "  LLM4TS_JUDGE_ROUNDS=1                         changed",
          "global   ~/.config/llm4ts/config.env",
          "  LLM4TS_CODER=pi   unchanged",
          "note: LLM4TS_PACK is also exported in this shell, which wins over the file"
        ].join("\n")
      )
      const files = yield* memory.files
      assert.strictEqual(
        files[projectPath],
        "LLM4TS_JUDGE_ROUNDS=1 # stage\nLLM4TS_PACK=j2ee-nextjs-spa\nLLM4TS_LEGACY_REPO=/home/u/demo/legacy-j2ee\n"
      )
      assert.strictEqual(files[globalPath], "LLM4TS_CODER=pi\n")
    })
  )

  it.effect("--global forces the file", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({})
      assert.strictEqual(
        yield* runConfigSet(deps, { repo, pairs: ["LLM4TS_JUDGE_ROUNDS=1"], target: "global" }),
        ["global   ~/.config/llm4ts/config.env", "  LLM4TS_JUDGE_ROUNDS=1   new"].join("\n")
      )
      assert.deepStrictEqual(Object.keys(yield* memory.files), [globalPath])
    })
  )

  for (const [label, pairs, message] of [
    [
      "an unknown name",
      ["LLM4TS_CODER=pi", "LLM4TS_JUDGE_ROUND=1"],
      "unknown setting LLM4TS_JUDGE_ROUND; did you mean LLM4TS_JUDGE_ROUNDS?"
    ],
    [
      "an unreadable value",
      ["LLM4TS_CODER=pi", "LLM4TS_JUDGE_ROUNDS=one"],
      "LLM4TS_JUDGE_ROUNDS must be a positive integer"
    ],
    [
      "a run-scoped setting",
      ["LLM4TS_CODER=pi", "LLM4TS_WAVE=wave-1"],
      "LLM4TS_WAVE is set per run: use llm4ts run --set LLM4TS_WAVE=<value>"
    ],
    [
      "a secret, without repeating it",
      ["LLM4TS_CODER=pi", "LLM4TS_MCP_TOKEN=s3cret-never-shown"],
      "LLM4TS_MCP_TOKEN is a secret: export it in the environment; it is never written to a file"
    ],
    [
      "an argument that is no assignment",
      ["LLM4TS_CODER=pi", "LLM4TS_JUDGE_ROUNDS"],
      "expected NAME=value, got an argument with no ="
    ]
  ] as const) {
    it.effect(`refuses ${label} and writes nothing`, () =>
      Effect.gen(function* () {
        const { deps, memory } = yield* world({})
        const error = yield* Effect.flip(runConfigSet(deps, { repo, pairs }))
        assert.strictEqual(error._tag, "ShellUsage")
        assert.strictEqual(error.message, message)
        assert.deepStrictEqual(yield* memory.files, {})
      })
    )
  }

  it.effect("creating the project file trusts it: the next show uses it", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({})
      yield* runConfigSet(deps, { repo, pairs: ["LLM4TS_JUDGE_ROUNDS=1"] })
      assert.deepStrictEqual(trustOf(yield* memory.files), {
        [repo]: contentHash("LLM4TS_JUDGE_ROUNDS=1\n")
      })
      const view = yield* configView(deps, repo)
      assert.strictEqual(view.loaded.projectTrust, "trusted")
      assert.strictEqual(view.loaded.resolution.settings.get("LLM4TS_JUDGE_ROUNDS")?.raw, "1")
    })
  )

  it.effect("each write to a trusted file trusts the new content, the editor's save included", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ files: { [projectPath]: "LLM4TS_PACK=a\n" } })
      yield* runConfigSet(deps, { repo, pairs: ["LLM4TS_CODER=pi"], target: "project" })
      const files = yield* memory.files
      assert.strictEqual(files[projectPath], "LLM4TS_PACK=a\nLLM4TS_CODER=pi\n")
      assert.deepStrictEqual(trustOf(files), { [repo]: contentHash(files[projectPath] ?? "") })
      assert.strictEqual((yield* configView(deps, repo)).loaded.projectTrust, "trusted")
    })
  )

  it.effect("keeps the trust other repositories hold", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [trustPath]: JSON.stringify({ "/elsewhere": "abc" }) }
      })
      yield* runConfigSet(deps, { repo, pairs: ["LLM4TS_JUDGE_ROUNDS=1"] })
      assert.deepStrictEqual(trustOf(yield* memory.files), {
        "/elsewhere": "abc",
        [repo]: contentHash("LLM4TS_JUDGE_ROUNDS=1\n")
      })
    })
  )

  it.effect(
    "refuses an untrusted project file, writes nothing, and still writes the global one",
    () =>
      Effect.gen(function* () {
        const { deps, memory } = yield* world({
          files: { [projectPath]: "LLM4TS_PACK=a\n" },
          trust: false
        })
        const error = yield* Effect.flip(
          runConfigSet(deps, { repo, pairs: ["LLM4TS_CODER=pi", "LLM4TS_PACK=b"] })
        )
        assert.strictEqual(error._tag, "ShellUsage")
        assert.strictEqual(error.message, writeRefused)
        assert.deepStrictEqual(yield* memory.files, { [projectPath]: "LLM4TS_PACK=a\n" })
        assert.include(yield* runConfigSet(deps, { repo, pairs: ["LLM4TS_CODER=pi"] }), "new")
        assert.deepStrictEqual(
          Object.keys(yield* memory.files).sort(),
          [globalPath, projectPath].sort()
        )
      })
  )

  it.effect("refuses a project file that changed since it was trusted", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ files: { [projectPath]: "LLM4TS_PACK=a\n" } })
      yield* memory.store.writeAtomic(projectPath, "LLM4TS_PACK=a\nLLM4TS_GATES=echo pwned\n")
      const before = yield* memory.files
      const error = yield* Effect.flip(runConfigSet(deps, { repo, pairs: ["LLM4TS_PACK=b"] }))
      assert.strictEqual(
        error.message,
        `${projectPath} has changed since it was trusted, so llm4ts writes nothing to it. Review and accept it first: llm4ts config trust --repo ${repo}`
      )
      assert.deepStrictEqual(yield* memory.files, before)
    })
  )
})

describe("config unset", () => {
  it.effect("removes a name from the files that hold it and says what it was", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: {
          [globalPath]: "LLM4TS_CODER=pi\nLLM4TS_JUDGE_ROUNDS=3\n",
          [projectPath]: "LLM4TS_JUDGE_ROUNDS=2\nLLM4TS_VERBOSTY=verbose\n"
        }
      })
      assert.strictEqual(
        yield* runConfigUnset(deps, {
          repo,
          names: ["LLM4TS_JUDGE_ROUNDS", "LLM4TS_VERBOSTY", "LLM4TS_PACK", "LLM4TS_PAK"]
        }),
        [
          "project  ~/demo/nextjs/.llm4ts/config.env",
          "  LLM4TS_JUDGE_ROUNDS   removed (was 2)",
          "  LLM4TS_VERBOSTY       removed",
          "global   ~/.config/llm4ts/config.env",
          "  LLM4TS_JUDGE_ROUNDS   removed (was 3)",
          "LLM4TS_PACK is not set in a config file",
          "LLM4TS_PAK is not set in a config file; did you mean LLM4TS_PACK?"
        ].join("\n")
      )
      const files = yield* memory.files
      assert.strictEqual(files[projectPath], "")
      assert.strictEqual(files[globalPath], "LLM4TS_CODER=pi\n")
    })
  )

  it.effect("--project leaves the global file alone", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [globalPath]: "LLM4TS_JUDGE_ROUNDS=3\n", [projectPath]: "LLM4TS_JUDGE_ROUNDS=2\n" }
      })
      yield* runConfigUnset(deps, { repo, names: ["LLM4TS_JUDGE_ROUNDS"], target: "project" })
      assert.strictEqual((yield* memory.files)[globalPath], "LLM4TS_JUDGE_ROUNDS=3\n")
    })
  )
})

describe("config unset and the trust list", () => {
  it.effect("a removal from a trusted file trusts what is left", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [projectPath]: "LLM4TS_PACK=a\nLLM4TS_JUDGE_ROUNDS=1\n" }
      })
      yield* runConfigUnset(deps, { repo, names: ["LLM4TS_PACK"] })
      const files = yield* memory.files
      assert.strictEqual(files[projectPath], "LLM4TS_JUDGE_ROUNDS=1\n")
      assert.deepStrictEqual(trustOf(files), { [repo]: contentHash("LLM4TS_JUDGE_ROUNDS=1\n") })
    })
  )

  it.effect(
    "an untrusted project file is left alone: said, and refused when asked for by name",
    () =>
      Effect.gen(function* () {
        const files = { [projectPath]: "LLM4TS_CODER=codex\n", [globalPath]: "LLM4TS_CODER=pi\n" }
        const { deps, memory } = yield* world({ files, trust: false })
        assert.strictEqual(
          yield* runConfigUnset(deps, { repo, names: ["LLM4TS_CODER"] }),
          [
            "global   ~/.config/llm4ts/config.env",
            "  LLM4TS_CODER   removed (was pi)",
            `left alone: ${writeRefused}`
          ].join("\n")
        )
        assert.deepStrictEqual(yield* memory.files, { ...files, [globalPath]: "" })
        const error = yield* Effect.flip(
          runConfigUnset(deps, { repo, names: ["LLM4TS_CODER"], target: "project" })
        )
        assert.strictEqual(error.message, writeRefused)
      })
  )
})

describe("config init", () => {
  const exported = {
    LLM4TS_PACK: "j2ee-nextjs-spa",
    LLM4TS_LEGACY_REPO: "../demo/legacy-j2ee",
    LLM4TS_JUDGE_ROUNDS: "1",
    LLM4TS_CODER: "pi",
    LLM4TS_WAVE: "wave-1",
    LLM4TS_MCP_TOKEN: "s3cret-never-shown",
    LLM4TS_EXTRACT_CONCURENCY: "3",
    LLM4TS_STALL_MINUTES: "soon",
    LLM4TS_REASONER: ""
  }

  it.effect("imports each export into the file its scope belongs in and reports the rest", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ environment: exported })
      const first = yield* runConfigInit(deps, { repo })
      assert.strictEqual(
        first,
        [
          "wrote ~/demo/nextjs/.llm4ts/config.env (project)",
          "  LLM4TS_PACK=j2ee-nextjs-spa                   from the environment",
          "  LLM4TS_LEGACY_REPO=/home/u/demo/legacy-j2ee   from the environment",
          "  LLM4TS_JUDGE_ROUNDS=1                         from the environment",
          "wrote ~/.config/llm4ts/config.env (global)",
          "  LLM4TS_CODER=pi   from the environment",
          "skipped LLM4TS_STALL_MINUTES must be a positive number of minutes",
          "skipped LLM4TS_WAVE is set per run: use llm4ts run --set LLM4TS_WAVE=<value>",
          "skipped LLM4TS_MCP_TOKEN is a secret: export it in the environment; it is never written to a file",
          "skipped LLM4TS_EXTRACT_CONCURENCY: not a setting; did you mean LLM4TS_EXTRACT_CONCURRENCY?",
          "these exports can now go from your shell profile: LLM4TS_CODER LLM4TS_PACK LLM4TS_LEGACY_REPO LLM4TS_JUDGE_ROUNDS",
          "check: llm4ts config show"
        ].join("\n")
      )
      assert.notInclude(first, "never-shown")
      const written = yield* memory.files
      assert.strictEqual(
        written[projectPath],
        "LLM4TS_PACK=j2ee-nextjs-spa\nLLM4TS_LEGACY_REPO=/home/u/demo/legacy-j2ee\nLLM4TS_JUDGE_ROUNDS=1\n"
      )
      assert.strictEqual(written[globalPath], "LLM4TS_CODER=pi\n")

      const second = yield* runConfigInit(deps, { repo })
      assert.deepStrictEqual(yield* memory.files, written)
      assert.include(
        second,
        "nothing to do: the config files hold every setting the environment sets"
      )
      assert.notInclude(second, "wrote")
    })
  )

  it.effect("never overwrites a line a file already has", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [globalPath]: "LLM4TS_CODER=codex\n" },
        environment: { LLM4TS_CODER: "pi" }
      })
      assert.strictEqual(
        yield* runConfigInit(deps, { repo }),
        [
          "kept LLM4TS_CODER: the global file already sets another value",
          "nothing to do: the config files hold every setting the environment sets"
        ].join("\n")
      )
      assert.strictEqual((yield* memory.files)[globalPath], "LLM4TS_CODER=codex\n")
    })
  )

  const answers: SeatAnswers = [
    { name: "LLM4TS_CODER", value: "codex" },
    { name: "LLM4TS_REASONER", value: "claude" }
  ]

  it.effect("with no global file writes the answers, an export winning over its answer", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ environment: { LLM4TS_CODER: "pi" } })
      assert.strictEqual(
        yield* runConfigInit(deps, { repo, ask: Effect.succeed(answers) }),
        [
          "wrote ~/.config/llm4ts/config.env (global)",
          "  LLM4TS_CODER=pi          from the environment",
          "  LLM4TS_REASONER=claude",
          "these exports can now go from your shell profile: LLM4TS_CODER",
          "check: llm4ts config show"
        ].join("\n")
      )
      assert.strictEqual(
        (yield* memory.files)[globalPath],
        "LLM4TS_CODER=pi\nLLM4TS_REASONER=claude\n"
      )
    })
  )

  it.effect("asks nothing once the global file exists", () =>
    Effect.gen(function* () {
      const { deps } = yield* world({ files: { [globalPath]: "# mine\n" } })
      assert.strictEqual(
        yield* runConfigInit(deps, { repo, ask: Effect.die("asked") }),
        "nothing to do: the config files hold every setting the environment sets"
      )
    })
  )

  it.effect("the project file it creates is trusted", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ environment: { LLM4TS_JUDGE_ROUNDS: "1" } })
      yield* runConfigInit(deps, { repo })
      assert.deepStrictEqual(trustOf(yield* memory.files), {
        [repo]: contentHash("LLM4TS_JUDGE_ROUNDS=1\n")
      })
      assert.strictEqual((yield* configView(deps, repo)).loaded.projectTrust, "trusted")
    })
  )

  it.effect("imports nothing into an untrusted project file, and still writes the global one", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [projectPath]: "LLM4TS_PACK=a\n" },
        environment: { LLM4TS_JUDGE_ROUNDS: "1", LLM4TS_CODER: "pi" },
        trust: false
      })
      assert.strictEqual(
        yield* runConfigInit(deps, { repo }),
        [
          "wrote ~/.config/llm4ts/config.env (global)",
          "  LLM4TS_CODER=pi   from the environment",
          `skipped LLM4TS_JUDGE_ROUNDS: ${writeRefused}`,
          "these exports can now go from your shell profile: LLM4TS_CODER",
          "check: llm4ts config show"
        ].join("\n")
      )
      assert.deepStrictEqual(yield* memory.files, {
        [projectPath]: "LLM4TS_PACK=a\n",
        [globalPath]: "LLM4TS_CODER=pi\n"
      })
    })
  )
})

describe("config trust", () => {
  const byHand = [
    "# from a colleague",
    "LLM4TS_JUDGE_ROUNDS=1",
    "LLM4TS_GATES=echo pwned",
    "LLM4TS_CODER_FLAGS=--dangerously-skip-permissions",
    "LLM4TS_MCP_TOKEN=s3cret-never-shown",
    "LLM4TS_NOPE=1",
    "LLM4TS_PACK=",
    "LLM4TS_TEST_ONE=x \u001b[1A\u001b[2K\u202e",
    "what is this",
    ""
  ].join("\n")

  it("the listing names every setting, tags what runs, hides a secret and shows rejected lines", () => {
    assert.strictEqual(
      renderTrustListing(byHand, projectPath),
      [
        `project file  ${projectPath}`,
        "  LLM4TS_JUDGE_ROUNDS   1",
        "  LLM4TS_GATES          echo pwned                       [runs as a command]",
        "  LLM4TS_CODER_FLAGS    --dangerously-skip-permissions   [flags for a coding agent]",
        "  LLM4TS_MCP_TOKEN      (value hidden)                   [a secret: ignored in a file]",
        "  LLM4TS_NOPE           1                                [not a setting: ignored]",
        "  LLM4TS_PACK           (empty)",
        "  LLM4TS_TEST_ONE       x \\u001b[1A\\u001b[2K\\u202e       [runs as a command]",
        "  line 9                what is this                     [rejected: not a NAME=value line]",
        "7 settings; llm4ts runs 2 values as a command"
      ].join("\n")
    )
    assert.strictEqual(
      renderTrustListing("# nothing yet\n", projectPath),
      [`project file  ${projectPath}`, "it sets nothing"].join("\n")
    )
  })

  const pending = (review: ProjectReview) => {
    assert.strictEqual(review._tag, "Pending")
    return review._tag === "Pending" ? review : assert.fail("not pending")
  }

  it.effect("no project file: nothing to trust", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({})
      const review = yield* reviewProject(deps, repo)
      assert.deepStrictEqual(review, { _tag: "Absent", projectPath })
      assert.deepStrictEqual(trustStep(review, { yes: true, interactive: true }), {
        kind: "done",
        line: `no project file at ${projectPath}: nothing to trust`
      })
      assert.deepStrictEqual(yield* memory.files, {})
    })
  )

  it.effect("accepting records the reviewed content, and the file is then used", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ files: { [projectPath]: byHand }, trust: false })
      const review = pending(yield* reviewProject(deps, repo))
      assert.strictEqual(review.listing, renderTrustListing(byHand, projectPath))
      assert.strictEqual(review.hash, contentHash(byHand))
      assert.deepStrictEqual(yield* memory.files, { [projectPath]: byHand })
      assert.strictEqual(
        yield* acceptProject(deps, review),
        `trusted: ${projectPath} (llm4ts reads it until its content changes)`
      )
      assert.deepStrictEqual(trustOf(yield* memory.files), { [repo]: contentHash(byHand) })
      const view = yield* configView(deps, repo)
      assert.strictEqual(view.loaded.projectTrust, "trusted")
      assert.strictEqual(view.loaded.resolution.settings.get("LLM4TS_GATES")?.raw, "echo pwned")
    })
  )

  it.effect("trusting again changes nothing and says it is already trusted", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({ files: { [projectPath]: byHand }, trust: false })
      yield* acceptProject(deps, pending(yield* reviewProject(deps, repo)))
      const once = yield* memory.files
      const again = yield* reviewProject(deps, repo)
      assert.deepStrictEqual(again, { _tag: "Trusted", projectPath })
      assert.deepStrictEqual(trustStep(again, { yes: true, interactive: false }), {
        kind: "done",
        line: `${projectPath} is already trusted`
      })
      assert.deepStrictEqual(yield* memory.files, once)
    })
  )

  it.effect("what was reviewed is what is trusted: a file swapped after the review stays out", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [projectPath]: "LLM4TS_JUDGE_ROUNDS=1\n" },
        trust: false
      })
      const review = pending(yield* reviewProject(deps, repo))
      yield* memory.store.writeAtomic(projectPath, "LLM4TS_GATES=echo pwned\n")
      yield* acceptProject(deps, review)
      const view = yield* configView(deps, repo)
      assert.strictEqual(view.loaded.projectTrust, "changed")
      assert.isFalse(view.loaded.resolution.settings.has("LLM4TS_GATES"))
    })
  )

  it.effect(
    "a pending review records with --yes, asks on a terminal, and stops unrecorded off one",
    () =>
      Effect.gen(function* () {
        const { deps, memory } = yield* world({ files: { [projectPath]: byHand }, trust: false })
        const review = yield* reviewProject(deps, repo)
        assert.deepStrictEqual(trustStep(review, { yes: true, interactive: false }), {
          kind: "record"
        })
        assert.deepStrictEqual(trustStep(review, { yes: false, interactive: true }), {
          kind: "ask"
        })
        assert.deepStrictEqual(trustStep(review, { yes: false, interactive: false }), {
          kind: "refuse",
          line: `not recorded: review the listing, then llm4ts config trust --repo ${repo} --yes, or answer on a terminal`
        })
        assert.deepStrictEqual(yield* memory.files, { [projectPath]: byHand })
      })
  )

  it.effect("a malformed trust list is replaced by the first acceptance", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* world({
        files: { [projectPath]: byHand, [trustPath]: "{ nope" },
        trust: false
      })
      yield* acceptProject(deps, pending(yield* reviewProject(deps, repo)))
      assert.deepStrictEqual(trustOf(yield* memory.files), { [repo]: contentHash(byHand) })
      assert.strictEqual((yield* configView(deps, repo)).loaded.projectTrust, "trusted")
    })
  )
})

describe("config untrust", () => {
  it.effect("removes this repository's record and no other", () =>
    Effect.gen(function* () {
      const project = "LLM4TS_JUDGE_ROUNDS=1\n"
      const { deps, memory } = yield* world({
        files: {
          [projectPath]: project,
          [trustPath]: JSON.stringify({ "/elsewhere": "abc", [repo]: contentHash(project) })
        },
        trust: false
      })
      assert.strictEqual((yield* configView(deps, repo)).loaded.projectTrust, "trusted")
      assert.strictEqual(
        yield* runConfigUntrust(deps, { repo }),
        `no longer trusted: ${projectPath}`
      )
      assert.deepStrictEqual(trustOf(yield* memory.files), { "/elsewhere": "abc" })
      assert.strictEqual((yield* configView(deps, repo)).loaded.projectTrust, "untrusted")
      assert.strictEqual(
        yield* runConfigUntrust(deps, { repo }),
        `${projectPath} was not trusted: nothing to remove`
      )
    })
  )
})
