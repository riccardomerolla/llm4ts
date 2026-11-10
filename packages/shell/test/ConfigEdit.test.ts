import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import { settingFacts, type Environment, type SettingName } from "@llm4ts/flow/Settings"
import {
  parseConfigFile,
  registryFacts,
  resolveConfig,
  type FileLayer,
  type Resolution
} from "@llm4ts/shell/Config"
import {
  editRequest,
  editableFacts,
  environmentNote,
  pickerRows,
  saveTargets,
  sessionSummary,
  settingActions,
  unlistedHint,
  valuePrompt,
  type SessionChange
} from "@llm4ts/shell/ConfigEdit"

const resolved = (files: {
  readonly global?: string
  readonly project?: string
  readonly environment?: Environment
}): Resolution =>
  resolveConfig({
    facts: registryFacts,
    flags: [],
    environment: files.environment ?? {},
    project:
      files.project === undefined ? undefined : parseConfigFile(files.project, "/r/.llm4ts/c"),
    global: files.global === undefined ? undefined : parseConfigFile(files.global, "/h/c"),
    repo: "/r",
    home: "/h"
  })

const demo = resolved({
  global: "LLM4TS_CODER=pi\n",
  project: "LLM4TS_JUDGE_ROUNDS=2\nLLM4TS_WORKTREE_SETUP=\n",
  environment: { LLM4TS_VERBOSITY: "quiet", LLM4TS_MCP_TOKEN: "t0ken-never-shown" }
})

describe("pickerRows", () => {
  const rows = pickerRows(demo)
  const columns = (name: SettingName): ReadonlyArray<string> =>
    (rows.find((row) => row.name === name)?.title ?? "").split(/\s{2,}/u)

  it("lists every setting a file may hold, and no other", () => {
    assert.deepStrictEqual(
      [...rows.map((row) => row.name)].sort(),
      editableFacts(registryFacts)
        .map((fact) => fact.name)
        .sort()
    )
    for (const row of rows) {
      assert.include(["global", "project"], settingFacts(row.name).scope, row.name)
    }
    assert.notInclude(rows.map((row) => row.title).join("\n"), "t0ken-never-shown")
  })

  it("puts the settings that are set first, the rest in registry order", () => {
    const set = ["LLM4TS_CODER", "LLM4TS_JUDGE_ROUNDS", "LLM4TS_WORKTREE_SETUP", "LLM4TS_VERBOSITY"]
    assert.sameMembers(
      rows.slice(0, set.length).map((row) => row.name),
      set
    )
    const rest = rows.slice(set.length).map((row) => row.name)
    assert.deepStrictEqual(
      rest,
      editableFacts(registryFacts)
        .map((fact) => fact.name)
        .filter((name) => !set.includes(name))
    )
  })

  it.each([
    ["LLM4TS_CODER", "pi", "global"],
    ["LLM4TS_JUDGE_ROUNDS", "2", "project"],
    ["LLM4TS_VERBOSITY", "quiet", "environment"],
    ["LLM4TS_WORKTREE_SETUP", "(empty)", "project"],
    [
      "LLM4TS_STALL_MINUTES",
      `(default: ${settingFacts("LLM4TS_STALL_MINUTES").fallback.text})`,
      "default"
    ]
  ] as const)("%s shows %s from %s", (name, value, source) => {
    assert.deepStrictEqual(columns(name), [name, value, source])
  })

  it("keeps a long value on one line", () => {
    const long = pickerRows(resolved({ global: `LLM4TS_CODER_MODEL=${"m".repeat(200)}\n` }))
    const title = long.find((row) => row.name === "LLM4TS_CODER_MODEL")?.title ?? ""
    assert.isBelow(title.length, 90)
    assert.include(title, "…")
    assert.isTrue(title.endsWith("global"))
  })

  it("names the group in the description", () => {
    assert.strictEqual(
      rows.find((row) => row.name === "LLM4TS_JUDGE_ROUNDS")?.description,
      "Review, judging and stalls"
    )
  })
})

describe("unlistedHint", () => {
  it("says how a per-run setting and a secret are set", () => {
    assert.include(unlistedHint, "--set NAME=value")
    assert.include(unlistedHint, "export them")
    assert.notInclude(unlistedHint, "\n")
  })
})

describe("editRequest", () => {
  it.each([
    [{ interactive: true }, Result.succeed(undefined)],
    [{ name: "LLM4TS_JUDGE_ROUNDS", interactive: true }, Result.succeed("LLM4TS_JUDGE_ROUNDS")],
    [
      { name: "LLM4TS_JUDGE_ROUND", interactive: true },
      Result.fail("unknown setting LLM4TS_JUDGE_ROUND; did you mean LLM4TS_JUDGE_ROUNDS?")
    ],
    [{ name: "NOPE", interactive: true }, Result.fail("unknown setting NOPE")],
    [
      { name: "LLM4TS_WAVE", interactive: true },
      Result.fail("LLM4TS_WAVE is set per run: use llm4ts run --set LLM4TS_WAVE=<value>")
    ],
    [
      { name: "LLM4TS_MCP_TOKEN", interactive: true },
      Result.fail(
        "LLM4TS_MCP_TOKEN is a secret: export it in the environment; it is never written to a file"
      )
    ],
    [{ name: "LLM4TS_FLOW", interactive: true }, Result.fail("LLM4TS_FLOW is set by llm4ts")],
    [
      { interactive: false },
      Result.fail(
        "config edit asks its questions on a terminal; here use llm4ts config set NAME=value"
      )
    ],
    [
      { name: "LLM4TS_JUDGE_ROUNDS", interactive: false },
      Result.fail(
        "config edit asks its questions on a terminal; here use llm4ts config set LLM4TS_JUDGE_ROUNDS=value"
      )
    ],
    [
      { name: "LLM4TS_JUDGE_ROUND", interactive: false },
      Result.fail("unknown setting LLM4TS_JUDGE_ROUND; did you mean LLM4TS_JUDGE_ROUNDS?")
    ]
  ] as const)("%o", (request, expected) => {
    assert.deepStrictEqual<Result.Result<string | undefined, string>>(
      editRequest(registryFacts, request),
      expected
    )
  })
})

describe("settingActions", () => {
  it.each([
    [[], ["change the value", "back"]],
    [["project"], ["change the value", "remove it from the project file", "back"]],
    [
      ["project", "global"],
      [
        "change the value",
        "remove it from the project file",
        "remove it from the global file",
        "back"
      ]
    ]
  ] as const)("held in %o", (held, titles) => {
    assert.deepStrictEqual(
      settingActions(held).map((choice) => choice.title),
      [...titles]
    )
  })
})

describe("valuePrompt", () => {
  it.each([
    ["LLM4TS_GEMINI_BRIDGE", { kind: "toggle" }],
    ["LLM4TS_GEMINI_BRIDGE_MODE", { kind: "choices", choices: ["acp", "model"] }],
    ["LLM4TS_CODER", { kind: "seat" }],
    ["LLM4TS_REASONER", { kind: "seat" }],
    ["LLM4TS_CODER_MODEL", { kind: "text" }],
    ["LLM4TS_JUDGE_ROUNDS", { kind: "text" }],
    ["LLM4TS_LEGACY_REPO", { kind: "text" }]
  ] as const)("%s", (name, expected) => {
    assert.deepStrictEqual(valuePrompt(settingFacts(name)), expected)
  })
})

describe("saveTargets", () => {
  const where = (
    inRepository: boolean,
    projectRefused: boolean,
    held: ReadonlyArray<FileLayer>
  ) => ({ inRepository, projectRefused, held })

  it.each([
    ["LLM4TS_CODER", where(true, false, []), ["global", "project"]],
    ["LLM4TS_CODER", where(true, false, ["global"]), ["global", "project"]],
    ["LLM4TS_CODER", where(true, false, ["project", "global"]), ["project", "global"]],
    ["LLM4TS_CODER", where(false, false, []), ["global"]],
    ["LLM4TS_CODER", where(true, true, []), ["global"]],
    ["LLM4TS_JUDGE_ROUNDS", where(true, false, []), ["project"]],
    ["LLM4TS_JUDGE_ROUNDS", where(false, false, ["global"]), ["project"]],
    ["LLM4TS_JUDGE_ROUNDS", where(true, true, []), ["project"]]
  ] as const)("%s %o", (name, given, expected) => {
    assert.deepStrictEqual(saveTargets(settingFacts(name), given), expected)
  })
})

describe("environmentNote", () => {
  it("speaks only when the export decides the value", () => {
    assert.include(
      environmentNote(demo, "LLM4TS_VERBOSITY") ?? "",
      "the export keeps winning over whatever is saved here"
    )
    assert.notInclude(environmentNote(demo, "LLM4TS_VERBOSITY") ?? "", "quiet")
    assert.isUndefined(environmentNote(demo, "LLM4TS_JUDGE_ROUNDS"))
    assert.isUndefined(environmentNote(demo, "LLM4TS_STALL_MINUTES"))
  })
})

describe("sessionSummary", () => {
  const set = (name: SettingName, layer: FileLayer): SessionChange => ({ name, layer, kind: "set" })

  it.each([
    [[], "nothing changed"],
    [[set("LLM4TS_JUDGE_ROUNDS", "project")], "changed: set LLM4TS_JUDGE_ROUNDS (project)"],
    [
      [
        set("LLM4TS_JUDGE_ROUNDS", "project"),
        set("LLM4TS_CODER", "global"),
        { name: "LLM4TS_JUDGE_ROUNDS", layer: "project", kind: "removed" }
      ],
      "changed: removed LLM4TS_JUDGE_ROUNDS (project), set LLM4TS_CODER (global)"
    ]
  ] as const)("%o", (changes, expected) => {
    assert.strictEqual(sessionSummary(changes), expected)
  })
})
