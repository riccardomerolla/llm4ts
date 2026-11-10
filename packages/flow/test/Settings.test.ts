import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Result from "effect/Result"
import {
  closestSettingName,
  isSettingName,
  readSetting,
  settingFacts,
  settingNames,
  settingValue,
  type SettingName
} from "@llm4ts/flow/Settings"

const read = (name: SettingName, raw: string): unknown => {
  const result = readSetting(name, raw)
  if (Result.isFailure(result)) {
    assert.fail(`${name} did not read '${raw}': ${result.failure}`)
  }
  return result.success
}

const refusal = (name: SettingName, raw: string): string => {
  const result = readSetting(name, raw)
  if (Result.isSuccess(result)) {
    assert.fail(`${name} read '${raw}'`)
  }
  return result.failure
}

const millis = (name: SettingName, raw: string): number => {
  const value = read(name, raw)
  if (!Duration.isDuration(value)) {
    assert.fail(`${name} did not read '${raw}' as a duration`)
  }
  return Duration.toMillis(value)
}

describe("setting grammars", () => {
  it("a toggle reads 1|true|on|yes and 0|false|off|no in any case", () => {
    for (const raw of ["1", "true", "on", "yes", "ON", "True", " yes "]) {
      assert.strictEqual(read("LLM4TS_GEMINI_BRIDGE", raw), true, raw)
    }
    for (const raw of ["0", "false", "off", "no", "OFF", "No"]) {
      assert.strictEqual(read("LLM4TS_GEMINI_BRIDGE", raw), false, raw)
    }
    for (const raw of ["maybe", "2", "enabled"]) {
      assert.strictEqual(refusal("LLM4TS_GEMINI_BRIDGE", raw), "on or off", raw)
    }
  })

  it("an empty value reads as unset unless the grammar gives it a meaning", () => {
    assert.isUndefined(read("LLM4TS_GEMINI_BRIDGE", ""))
    assert.isUndefined(read("LLM4TS_GATES", "   "))
    assert.strictEqual(read("LLM4TS_WORKTREE_SETUP", ""), "")
    assert.isTrue(settingFacts("LLM4TS_WORKTREE_SETUP").emptyIsValue)
    assert.isFalse(settingFacts("LLM4TS_GATES").emptyIsValue)
  })

  it("positive takes integers from 1, count from 0", () => {
    assert.strictEqual(read("LLM4TS_JUDGE_ROUNDS", " 3 "), 3)
    for (const raw of ["0", "-1", "1.5", "one", "3x"]) {
      assert.strictEqual(refusal("LLM4TS_JUDGE_ROUNDS", raw), "a positive integer", raw)
    }
    assert.strictEqual(read("LLM4TS_ORIENTATION_CHARS", "0"), 0)
    assert.strictEqual(read("LLM4TS_ORIENTATION_CHARS", "12000"), 12_000)
    assert.strictEqual(refusal("LLM4TS_ORIENTATION_CHARS", "-1"), "a whole number, 0 or more")
  })

  it("seconds, minutes and spans read as durations", () => {
    assert.strictEqual(millis("LLM4TS_GATE_TIMEOUT", "90"), 90_000)
    for (const raw of ["0", "90s", "soon"]) {
      assert.isTrue(Result.isFailure(readSetting("LLM4TS_GATE_TIMEOUT", raw)), raw)
    }
    assert.strictEqual(millis("LLM4TS_STALL_MINUTES", "10"), 600_000)
    assert.strictEqual(millis("LLM4TS_STALL_MINUTES", "0.5"), 30_000)
    for (const raw of ["0", "soon", "-2"]) {
      assert.isTrue(Result.isFailure(readSetting("LLM4TS_STALL_MINUTES", raw)), raw)
    }
    assert.strictEqual(millis("LLM4TS_IDLE_AFTER", "90s"), 90_000)
    assert.strictEqual(millis("LLM4TS_IDLE_AFTER", "5m"), 300_000)
    assert.strictEqual(millis("LLM4TS_IDLE_AFTER", "1h"), 3_600_000)
    assert.strictEqual(millis("LLM4TS_IDLE_AFTER", "45"), 45_000)
    assert.isTrue(Result.isFailure(readSetting("LLM4TS_IDLE_AFTER", "5d")))
  })

  it("text is trimmed; a path and a command say what they are", () => {
    assert.strictEqual(read("LLM4TS_WAVE", "  wave-1 "), "wave-1")
    assert.strictEqual(read("LLM4TS_LEGACY_REPO", "~/legacy/ib-core"), "~/legacy/ib-core")
    assert.isTrue(settingFacts("LLM4TS_LEGACY_REPO").path)
    assert.isFalse(settingFacts("LLM4TS_WAVE").path)
    assert.strictEqual(
      read("LLM4TS_TEST_ONE", "pnpm vitest -t {tagRegex}"),
      "pnpm vitest -t {tagRegex}"
    )
    assert.isTrue(settingFacts("LLM4TS_TEST_ONE").runs)
    assert.isTrue(settingFacts("LLM4TS_GATES").runs)
    assert.isFalse(settingFacts("LLM4TS_PACK").runs)
  })

  it("a url must be http or https", () => {
    assert.strictEqual(
      read("LLM4TS_ADO_ORG_URL", "https://dev.azure.com/acme"),
      "https://dev.azure.com/acme"
    )
    for (const raw of ["dev.azure.com/acme", "ftp://dev.azure.com", "https://"]) {
      assert.strictEqual(refusal("LLM4TS_ADO_ORG_URL", raw), "an http or https URL", raw)
    }
  })

  it("commands split on ; and names on ,", () => {
    assert.deepStrictEqual(read("LLM4TS_GATES", "pnpm typecheck; pnpm test;"), [
      "pnpm typecheck",
      "pnpm test"
    ])
    assert.isTrue(Result.isFailure(readSetting("LLM4TS_GATES", " ; ")))
    assert.deepStrictEqual(read("LLM4TS_EXECUTORS", "pi-a, codex,,claude"), [
      "pi-a",
      "codex",
      "claude"
    ])
    assert.isTrue(Result.isFailure(readSetting("LLM4TS_EXECUTORS", ",")))
  })

  it("cli flags split on ; and on the first =", () => {
    assert.deepStrictEqual(read("LLM4TS_CODER_FLAGS", "config=model_provider=lmstudio; yolo"), {
      config: "model_provider=lmstudio",
      yolo: ""
    })
    assert.isTrue(Result.isFailure(readSetting("LLM4TS_CODER_FLAGS", "=lmstudio")))
  })

  it("a choice reads in any case and names its choices when refused", () => {
    assert.strictEqual(read("LLM4TS_VERBOSITY", "Verbose"), "verbose")
    assert.strictEqual(refusal("LLM4TS_VERBOSITY", "loud"), "quiet, normal, verbose or debug")
    assert.strictEqual(refusal("LLM4TS_REVIEW_FIXER", "other"), "separate")
  })

  it("a refusal never carries the raw value", () => {
    for (const name of settingNames) {
      const result = readSetting(name, "hunter2 hunter2")
      if (Result.isFailure(result)) {
        assert.notInclude(result.failure, "hunter2", name)
      }
    }
  })
})

describe("settingValue", () => {
  it("returns the default of a setting that has one", () => {
    const timeout: Duration.Duration = settingValue("LLM4TS_GATE_TIMEOUT", {})
    assert.strictEqual(Duration.toSeconds(timeout), 1200)
    const bridge: boolean = settingValue("LLM4TS_GEMINI_BRIDGE", {})
    assert.isFalse(bridge)
    assert.isTrue(settingValue("LLM4TS_NODE_CHECK", {}))
    assert.strictEqual(settingValue("LLM4TS_VERBOSITY", {}), "normal")
    assert.strictEqual(settingValue("LLM4TS_CONTEXT_BUDGET", {}), 400_000)
  })

  it("returns undefined for an unset setting each flow defaults itself", () => {
    const rounds: number | undefined = settingValue("LLM4TS_JUDGE_ROUNDS", {})
    assert.isUndefined(rounds)
    assert.isUndefined(settingValue("LLM4TS_LEGACY_REPO", {}))
    assert.isUndefined(settingValue("LLM4TS_TRANSCRIPT", {}))
  })

  it("decodes what the environment holds", () => {
    const environment = {
      LLM4TS_NODE_CHECK: "off",
      LLM4TS_JUDGE_ROUNDS: "1",
      LLM4TS_GATE_TIMEOUT: "60",
      LLM4TS_OTEL_CONTENT: "FULL",
      LLM4TS_WORKTREE_SETUP: ""
    }
    assert.isFalse(settingValue("LLM4TS_NODE_CHECK", environment))
    assert.strictEqual(settingValue("LLM4TS_JUDGE_ROUNDS", environment), 1)
    assert.strictEqual(Duration.toSeconds(settingValue("LLM4TS_GATE_TIMEOUT", environment)), 60)
    assert.strictEqual(settingValue("LLM4TS_OTEL_CONTENT", environment), "full")
    assert.strictEqual(settingValue("LLM4TS_WORKTREE_SETUP", environment), "")
  })

  it("treats an empty or unreadable value as unset", () => {
    assert.strictEqual(
      settingValue("LLM4TS_CONTEXT_BUDGET", { LLM4TS_CONTEXT_BUDGET: "" }),
      400_000
    )
    assert.strictEqual(
      settingValue("LLM4TS_CONTEXT_BUDGET", { LLM4TS_CONTEXT_BUDGET: "lots" }),
      400_000
    )
    assert.isUndefined(settingValue("LLM4TS_STALL_MINUTES", { LLM4TS_STALL_MINUTES: "soon" }))
  })
})

describe("settingFacts", () => {
  it("every setting has a doc, a grammar and a fallback text", () => {
    assert.isAbove(settingNames.length, 90)
    for (const name of settingNames) {
      const facts = settingFacts(name)
      assert.strictEqual(facts.name, name)
      assert.isAbove(facts.doc.length, 10, name)
      assert.isAbove(facts.grammar.length, 0, name)
      assert.isAbove(facts.fallback.text.length, 0, name)
    }
  })

  it("carries flags, requirements and the shell-only mark", () => {
    assert.strictEqual(settingFacts("LLM4TS_PACK").flag, "--pack")
    assert.isUndefined(settingFacts("LLM4TS_WAVE").flag)
    assert.deepStrictEqual(settingFacts("LLM4TS_FORK_AS").requiredBy, ["pack-fork"])
    assert.deepStrictEqual(settingFacts("LLM4TS_WAVE").requiredBy, [])
    assert.include(settingFacts("LLM4TS_LEGACY_REPO").requiredBy, "convert-all")
    assert.notInclude(settingFacts("LLM4TS_LEGACY_REPO").requiredBy, "epic-design")
    assert.isTrue(settingFacts("LLM4TS_MCP_TOKEN").shellOnly)
    assert.strictEqual(settingFacts("LLM4TS_MCP_TOKEN").scope, "secret")
    assert.isFalse(settingFacts("LLM4TS_GEMINI_BRIDGE_TOKEN").shellOnly)
    assert.deepStrictEqual(settingFacts("LLM4TS_GATE_TIMEOUT").fallback, {
      kind: "default",
      text: "1200 seconds"
    })
    assert.strictEqual(settingFacts("LLM4TS_CODER").fallback.kind, "per-flow")
    assert.strictEqual(settingFacts("LLM4TS_WAVE").fallback.kind, "off")
  })

  it("only run-scoped, secret and internal settings stay out of files", () => {
    assert.strictEqual(settingFacts("LLM4TS_WAVE").scope, "run")
    assert.strictEqual(settingFacts("LLM4TS_FLOW").scope, "internal")
    assert.strictEqual(settingFacts("LLM4TS_CODER").scope, "global")
    assert.strictEqual(settingFacts("LLM4TS_PACK").scope, "project")
  })
})

describe("closestSettingName", () => {
  it("knows a setting by its exact name only", () => {
    assert.isTrue(isSettingName("LLM4TS_PACK"))
    assert.isFalse(isSettingName("LLM4TS_PAK"))
    assert.isFalse(isSettingName("toString"))
    assert.strictEqual(closestSettingName("LLM4TS_PACK"), "LLM4TS_PACK")
  })

  it("finds a dropped, added or wrong letter", () => {
    assert.strictEqual(
      closestSettingName("LLM4TS_EXTRACT_CONCURENCY"),
      "LLM4TS_EXTRACT_CONCURRENCY"
    )
    assert.strictEqual(closestSettingName("LLM4TS_JUDGE_ROUND"), "LLM4TS_JUDGE_ROUNDS")
    assert.strictEqual(closestSettingName("LLM4TS_LEGACY_REPOS"), "LLM4TS_LEGACY_REPO")
    assert.strictEqual(closestSettingName("LLM4TS_VERBOSITI"), "LLM4TS_VERBOSITY")
  })

  it("finds two swapped letters", () => {
    assert.strictEqual(closestSettingName("LLM4TS_COEDR"), "LLM4TS_CODER")
    assert.strictEqual(closestSettingName("LLM4TS_PCAK"), "LLM4TS_PACK")
  })

  it("finds the same words in another order", () => {
    assert.strictEqual(closestSettingName("LLM4TS_REPO_LEGACY"), "LLM4TS_LEGACY_REPO")
    assert.strictEqual(closestSettingName("LLM4TS_ROUNDS_JUDGE"), "LLM4TS_JUDGE_ROUNDS")
  })

  it("gives nothing for a name that is far from every setting", () => {
    assert.isUndefined(closestSettingName("LLM4TS_MY_OWN_KNOB"))
    assert.isUndefined(closestSettingName("LLM4TS_XY"))
    assert.isUndefined(closestSettingName("LLM4TS_"))
    assert.isUndefined(closestSettingName("PATH"))
    assert.isUndefined(closestSettingName("OTEL_SDK_DISABLED"))
  })
})
