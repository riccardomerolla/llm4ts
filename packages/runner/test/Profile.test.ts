import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EpicRun, appendEpicRun } from "@llm4ts/flow/EpicRuns"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  Info,
  StageCompleted,
  StageStarted,
  Timed,
  TokensUsed,
  ToolUse,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import type { TreeInput } from "@llm4ts/runner/AgentTree"
import { ProfileReport, makeProfileProgram, profileOf, renderProfile } from "@llm4ts/runner/Profile"

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
        "coder turns: 3, 12m00s (40% of story time), avg 4m00s, first output after 20s",
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

  it("estimates from an older trace that has no timings, and says so", () => {
    const report = profileOf([
      at(0, StageStarted.make({ stage: "story plan" })),
      at(0.2, StageCompleted.make({ stage: "story plan" })),
      at(0.5, StageStarted.make({ stage: "story done-before", lane: "done-before" })),
      at(0.5, Info.make({ message: "story done-before: already merged; skipping", lane: "done-before" })),
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
