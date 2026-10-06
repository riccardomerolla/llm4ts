import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EpicRun, appendEpicRun } from "@llm4ts/flow/EpicRuns"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  EvidenceChecked,
  Info,
  StageCompleted,
  StageStarted,
  StoryJudged,
  Timed,
  TokensUsed,
  ToolUse,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import type { TreeInput } from "@llm4ts/runner/AgentTree"
import {
  ProfileReport,
  makeProfileProgram,
  profileDelta,
  profileOf,
  renderProfile,
  renderProfileDelta
} from "@llm4ts/runner/Profile"

const t0 = 1_790_000_000_000
const at = (seconds: number, event: FlowEvent): TreeInput => ({
  _tag: "Event",
  at: t0 + seconds * 1_000,
  event
})
const minute = 60

const tokens = (lane: string, prompt: number) =>
  TokensUsed.make({
    agent: "coder",
    usage: TokenUsage.make({ prompt, completion: 100, total: prompt + 100 }),
    lane
  })

/**
 * One story, "home", 30 minutes on its lane: coder turns of 2 + 4 + 6 minutes
 * (3 of them in tools), `pnpm test` run three times for 4 minutes each (one
 * red), a reviewer call of 2 minutes, 1 minute queued for the merge lock and a
 * 1-minute merge. It started 5 minutes after the plan was ready.
 */
const measured: ReadonlyArray<TreeInput> = [
  at(0, StageStarted.make({ stage: "story plan" })),
  at(60, StageCompleted.make({ stage: "story plan" })),
  at(60 + 5 * minute, StageStarted.make({ stage: "story home", lane: "home", executor: "gemini" })),
  ...[2, 4, 6].map((minutes, turn) =>
    at(
      360 + turn * 600,
      Timed.make({
        kind: "model",
        label: "coder",
        ms: minutes * 60_000,
        firstMs: 20_000,
        lane: "home",
        executor: "gemini"
      })
    )
  ),
  at(361, tokens("home", 1_000)),
  at(961, tokens("home", 2_500)),
  at(1561, tokens("home", 4_000)),
  at(900, Timed.make({ kind: "tool", label: "run_shell_command", ms: 180_000, lane: "home" })),
  ...[0, 1, 2].map((run) =>
    at(
      1000 + run * 300,
      Timed.make({
        kind: "gate",
        label: "pnpm test",
        ms: 240_000,
        exitCode: run === 0 ? 1 : 0,
        ...(run === 0 ? { failed: true } : {}),
        lane: "home"
      })
    )
  ),
  at(1700, Timed.make({ kind: "model", label: "reviewer", ms: 120_000, lane: "home" })),
  at(2060, Timed.make({ kind: "wait", label: "merge lock", ms: 60_000, lane: "home" })),
  at(2120, Timed.make({ kind: "merge", label: "merge", ms: 60_000, lane: "home" })),
  at(2160, Info.make({ message: "story home: merged into epic/x", lane: "home" })),
  at(2160, StageCompleted.make({ stage: "story home", lane: "home" }))
]

describe("profileOf", () => {
  it("splits a story's time into model, tools, gates, merge, waiting and the rest", () => {
    const report = profileOf(measured)
    assert.isFalse(report.estimated)
    const [home] = report.stories
    assert.strictEqual(home?.id, "home")
    assert.strictEqual(home?.wallMs, 30 * 60_000)
    assert.strictEqual(home?.queuedMs, 5 * 60_000)
    assert.deepStrictEqual(home?.time, {
      // 12 coder minutes less 3 in tools, plus 2 reviewer minutes
      model: 11 * 60_000,
      tools: 3 * 60_000,
      gates: 12 * 60_000,
      merge: 60_000,
      waiting: 60_000,
      unaccounted: 2 * 60_000
    })
    assert.deepStrictEqual(
      [home?.turns.count, home?.turns.avgMs, home?.turns.firstPrompt, home?.turns.lastPrompt],
      [3, 4 * 60_000, 1_000, 4_000]
    )
    assert.isTrue(home?.turns.promptGrowth)
  })

  it("adds up model calls by role and executor, and gates by command", () => {
    const report = profileOf(measured)
    assert.deepStrictEqual(
      report.models.map((row) => [row.role, row.executor, row.calls, row.ms, row.avgFirstMs]),
      [
        ["coder", "gemini", 3, 12 * 60_000, 20_000],
        ["reviewer", undefined, 1, 2 * 60_000, undefined]
      ]
    )
    assert.deepStrictEqual(
      report.gates.map((row) => [row.command, row.runs, row.ms, row.failed]),
      [["pnpm test", 3, 12 * 60_000, 1]]
    )
  })

  it("ranks the biggest time sinks first, in plain words, with no content", () => {
    const report = profileOf(measured)
    assert.deepStrictEqual(
      report.findings.slice(0, 3).map((finding) => finding.text),
      [
        "coder turns: 3, 12m00s (40% of story time), avg 4m00s, first output after 20s, 0.3 steps per turn, 2m50s of model per step",
        "gate `pnpm test`: 3 runs, 12m00s (40% of story time), 1 failed",
        "stories queued before starting (dependencies, free coder slots): 5m00s in all"
      ]
    )
    assert.deepStrictEqual(
      report.tools.map((row) => [row.label, row.count, row.ms]),
      [["run_shell_command", 1, 3 * 60_000]]
    )
    assert.include(
      report.findings.map((finding) => finding.text).join("\n"),
      "home: coder prompts grew 4.0× (1.0k → 4.0k tokens): every turn resends the history"
    )
    const text = renderProfile(report)
    assert.include(text, "Where the time goes")
    assert.include(text, "home")
    assert.notInclude(text, "epic/x")
  })

  it("explains unaccounted time by its largest untimed gaps, and shows time timed outside any story", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(60, Timed.make({ kind: "model", label: "coder", ms: 60_000, lane: "home" })),
      at(100, ToolUse.make({ tool: "bash", args: "pnpm test", lane: "home" })),
      at(
        400,
        StoryJudged.make({ lane: "home", round: 1, cleared: true, issues: 0, dimensions: [] })
      ),
      at(420, StageCompleted.make({ stage: "story home", lane: "home" })),
      at(430, Timed.make({ kind: "model", label: "reasoning", ms: 90_000 }))
    ])
    const [home] = report.stories
    assert.deepStrictEqual(home?.gaps, [
      { ms: 300_000, after: "a coder tool call", before: "a judge verdict" },
      { ms: 40_000, after: "the end of a coder call", before: "a coder tool call" }
    ])
    assert.deepStrictEqual(report.outside, [{ label: "reasoning", count: 1, ms: 90_000 }])
    const text = renderProfile(report)
    assert.include(text, "home: 5m00s between a coder tool call and a judge verdict")
    assert.include(text, "Timed outside any story")
  })

  it("counts the steps in a coder turn, the model time per step, and tool time by category", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      // One 10-minute turn: 4 tool calls taking 2 minutes, so 8 minutes of model over 5 steps.
      ...[1, 2, 3, 4].map((n) =>
        at(
          n * 100,
          Timed.make({
            kind: "tool",
            label: "run_shell_command",
            category: n <= 2 ? "test" : "explore",
            ms: 30_000,
            lane: "home"
          })
        )
      ),
      at(600, Timed.make({ kind: "model", label: "coder", ms: 600_000, lane: "home" })),
      at(600, StageCompleted.make({ stage: "story home", lane: "home" }))
    ])
    const [home] = report.stories
    assert.deepStrictEqual([home?.turns.avgSteps, home?.turns.avgStepMs], [4, 96_000])
    assert.deepStrictEqual(
      report.toolCategories.map((row) => [row.label, row.count, row.ms]),
      [
        ["test", 2, 60_000],
        ["explore", 2, 60_000]
      ]
    )
    const findings = report.findings.map((finding) => finding.text).join("\n")
    assert.include(
      findings,
      "coder turns: 1, 10m00s (100% of story time), avg 10m00s, 4 steps per turn, 1m36s of model per step"
    )
    assert.include(findings, "coder tools, test: 2 calls, 1m00s (10% of story time)")
  })

  it("counts a coder turn still running as model time, less its tools so far", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(60, ToolUse.make({ tool: "run_shell_command", args: "pnpm test", lane: "home" })),
      at(70, Timed.make({ kind: "tool", label: "run_shell_command", ms: 10_000, lane: "home" })),
      at(120, ToolUse.make({ tool: "read_file", args: "a.ts", lane: "home" })),
      at(130, Timed.make({ kind: "tool", label: "read_file", ms: 10_000, lane: "home" })),
      // The trace ends mid-turn: the run is still going.
      at(
        900,
        TokensUsed.make({
          agent: "reviewer",
          usage: TokenUsage.make({ prompt: 1, completion: 1, total: 2 })
        })
      )
    ])
    const [home] = report.stories
    assert.strictEqual(home?.openTurnMs, 900_000)
    assert.deepStrictEqual(
      [home?.time.model, home?.time.tools, home?.time.unaccounted],
      [880_000, 20_000, 0]
    )
    assert.include(
      report.findings.map((finding) => finding.text).join("\n"),
      "home: a coder turn still running for 15m00s (2 tool calls so far)"
    )
  })

  it("estimates from an older trace that has no timings, and says so", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story plan" })),
      at(0.2, StageCompleted.make({ stage: "story plan" })),
      at(0.5, StageStarted.make({ stage: "story done-before", lane: "done-before" })),
      at(
        0.5,
        Info.make({ message: "story done-before: already merged; skipping", lane: "done-before" })
      ),
      at(0.5, StageCompleted.make({ stage: "story done-before", lane: "done-before" })),
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(100, tokens("home", 1_000)),
      // Tools inside a turn are part of it, not its start.
      at(200, ToolUse.make({ tool: "bash", args: "pnpm test", lane: "home" })),
      at(300, ToolUse.make({ tool: "read", args: "a.ts", lane: "home" })),
      at(400, tokens("home", 2_000)),
      at(500, StageCompleted.make({ stage: "story home", lane: "home" }))
    ])
    assert.isTrue(report.estimated)
    assert.deepStrictEqual(report.skipped, ["done-before"])
    assert.notInclude(
      report.findings.map((finding) => finding.text).join("\n"),
      "queued before starting"
    )
    assert.deepStrictEqual(
      [report.stories[0]?.wallMs, report.stories[0]?.time.model, report.stories[0]?.turns.count],
      [500_000, 400_000, 2]
    )
    assert.include(renderProfile(report), "estimated")
  })
})

describe("profileDelta (ADR 0029)", () => {
  it("compares two runs in the harness-evals order and says which way each moved", () => {
    const before = profileOf(measured)
    const after = profileOf([
      ...measured,
      at(2200, Timed.make({ kind: "model", label: "reviewer", ms: 120_000, lane: "home" }))
    ])
    const delta = profileDelta(before, after)
    const rows = Object.fromEntries(delta.rows.map((row) => [row.label, row]))
    assert.strictEqual(rows["stories done"]?.before, 1)
    assert.strictEqual(rows["reviewer calls"]?.before, 1)
    assert.strictEqual(rows["reviewer calls"]?.after, 2)
    assert.strictEqual(rows["gate failures"]?.before, 1)
    assert.strictEqual(rows["model time"]?.unit, "ms")
    assert.deepStrictEqual(
      delta.rows.slice(0, 3).map((row) => row.label),
      ["stories done", "stories failed", "explore calls before the first edit"]
    )
    const text = renderProfileDelta(delta, { before: "before.json", after: "trace-2.jsonl" })
    assert.include(text, "llm4ts profile · before.json → trace-2.jsonl")
    assert.match(text, /reviewer calls\s+1\s+2\s+\+1 \(100%\) worse/)
    assert.match(text, /stories done\s+1\s+1\s+=/)
    assert.include(text, "llm4ts costs --repo <repo>")
  })
})

describe("makeProfileProgram", () => {
  it.effect("profiles an epic's latest run, as text or as JSON", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({
        "/repo/.llm4ts/trace-1.jsonl": readFileSync(
          new URL("./fixtures/agent-tree.trace.jsonl", import.meta.url),
          "utf8"
        )
      })
      yield* appendEpicRun(
        memory.store,
        "/repo/.llm4ts/epics/conto",
        EpicRun.make({
          runId: "run-fixture",
          tracePath: "/repo/.llm4ts/trace-1.jsonl",
          action: "RunPlan",
          startedAt: 1
        })
      )
      const sources = {
        files: memory.store,
        listTraces: () => [],
        listEpics: () => ["conto"]
      }
      const text = yield* makeProfileProgram({ repo: "/repo", epic: "conto" }, sources)
      assert.include(text, "Where the time goes")
      assert.include(text, "accounts")
      const json = yield* makeProfileProgram({ repo: "/repo", epic: "conto", json: true }, sources)
      const report = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileReport))(json)
      assert.deepStrictEqual(
        report.stories.map((story) => story.id),
        ["accounts", "payments", "iban", "overview"]
      )
    })
  )
})

/**
 * One story, "list", whose coder gave itself two tasks and spent 16 explore
 * calls over 8 minutes before its first edit; a later test call; 10 minutes
 * in all.
 */
const wandering: ReadonlyArray<TreeInput> = [
  at(0, StageStarted.make({ stage: "story list", lane: "list", executor: "gemini" })),
  at(0, StageStarted.make({ stage: "Add the list page", lane: "list" })),
  ...Array.from({ length: 16 }, (_, index) =>
    at(
      10 + index * 30,
      Timed.make({ kind: "tool", label: "grep", category: "explore", ms: 200, lane: "list" })
    )
  ),
  at(
    8 * minute,
    Timed.make({ kind: "tool", label: "write_file", category: "edit", ms: 300, lane: "list" })
  ),
  at(8 * minute + 5, Timed.make({ kind: "model", label: "coder", ms: 8 * 60_000, lane: "list" })),
  at(8 * minute + 10, StageStarted.make({ stage: "Add the list test", lane: "list" })),
  at(
    9 * minute,
    Timed.make({
      kind: "tool",
      label: "run_shell_command",
      category: "test",
      ms: 20_000,
      lane: "list"
    })
  ),
  at(
    9 * minute + 30,
    Timed.make({ kind: "tool", label: "write_file", category: "edit", ms: 300, lane: "list" })
  ),
  at(10 * minute, Timed.make({ kind: "model", label: "coder", ms: 110_000, lane: "list" })),
  at(10 * minute, StageCompleted.make({ stage: "story list", lane: "list" }))
]

describe("coder work per story", () => {
  it("counts tool calls by kind, the coder's tasks, and what came before the first edit", () => {
    const [list] = profileOf(wandering).stories
    assert.deepStrictEqual(list?.toolCalls, { explore: 16, edit: 2, test: 1, other: 0 })
    assert.strictEqual(list?.tasks, 2)
    assert.strictEqual(list?.firstEditMs, 8 * 60_000)
    assert.strictEqual(list?.exploreBeforeEdit, 16)
  })

  it("names a story that found its way instead of being told where to go", () => {
    const findings = profileOf(wandering).findings.map((finding) => finding.text)
    assert.include(
      findings.join("\n"),
      "list: 16 explore calls and 8m00s before the coder's first edit — it found its way instead of being told where to go"
    )
    const text = renderProfile(profileOf(wandering))
    assert.include(text, "Coder work per story")
    assert.include(text, "before 1st edit")
  })

  it("an older trace without tool categories profiles as before", () => {
    const [home] = profileOf(measured).stories
    assert.deepStrictEqual(home?.toolCalls, { explore: 0, edit: 0, test: 0, other: 0 })
    assert.isUndefined(home?.firstEditMs)
    assert.strictEqual(home?.exploreBeforeEdit, 0)
    assert.notInclude(renderProfile(profileOf(measured)), "Coder work per story")
    assert.notInclude(
      profileOf(measured)
        .findings.map((finding) => finding.text)
        .join("\n"),
      "found its way"
    )
  })

  it("measures the first edit from the first task, and does not call a story that read its context wandering", () => {
    const settled: ReadonlyArray<TreeInput> = [
      at(0, StageStarted.make({ stage: "story calm", lane: "calm", executor: "gemini" })),
      at(1, StageStarted.make({ stage: "story calm: setup", lane: "calm" })),
      at(5 * minute, StageStarted.make({ stage: "Add the page", lane: "calm" })),
      at(
        7 * minute,
        Timed.make({ kind: "tool", label: "write_file", category: "edit", ms: 300, lane: "calm" })
      ),
      at(7 * minute + 30, Timed.make({ kind: "model", label: "coder", ms: 150_000, lane: "calm" })),
      at(8 * minute, StageCompleted.make({ stage: "story calm", lane: "calm" }))
    ]
    const report = profileOf(settled)
    const [calm] = report.stories
    assert.strictEqual(calm?.tasks, 1)
    assert.strictEqual(calm?.firstEditMs, 2 * minute * 1_000)
    assert.strictEqual(calm?.exploreBeforeEdit, 0)
    assert.notInclude(report.findings.map((finding) => finding.text).join("\n"), "found its way")
  })
})

describe("evidence per story (ADR 0027)", () => {
  it("counts unverified claims and low-confidence tasks, and names a story whose coder fabricated status", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story list", lane: "list", executor: "gemini" })),
      at(0, StageStarted.make({ stage: "Add the list page", lane: "list" })),
      at(
        60_000,
        EvidenceChecked.make({
          task: "Add the list page",
          claimed: 2,
          unverified: 1,
          confidence: "low",
          lane: "list"
        })
      ),
      at(
        90_000,
        EvidenceChecked.make({ task: "Add the list test", claimed: 1, unverified: 0, lane: "list" })
      ),
      at(120_000, StageCompleted.make({ stage: "story list", lane: "list" }))
    ])
    const [list] = report.stories
    assert.strictEqual(list?.unverifiedClaims, 1)
    assert.strictEqual(list?.lowConfidenceTasks, 1)
    assert.isTrue(
      report.findings.some((finding) =>
        finding.text.includes("list: the coder claimed 1 verification command that never ran")
      )
    )
  })
})
