import { readFileSync, writeFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
  Began,
  StageCompleted,
  StageFailed,
  ExecutorExcluded,
  ExecutorHandedOver,
  ExecutorLeased,
  ExecutorReleased,
  ExecutorResumed,
  Info,
  JudgmentObserved,
  StoryJudged,
  StageStarted,
  StoryStatusChanged,
  TaskCompleted,
  TaskStarted,
  TasksPlanned,
  Timed,
  TokensUsed,
  ToolUse,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import { TokenUsage } from "@llm4ts/core/Models"
import { origins, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  emptyTree,
  idleAfterFrom,
  initialView,
  onTreeKey,
  tailTargetOf,
  reduceTree,
  renderTree,
  selectedLane,
  treeInputsOfTrace,
  type TreeInput,
  type TreeState,
  type TreeView
} from "@llm4ts/runner/AgentTree"

const t0 = 1_790_000_000_000

const at = (seconds: number, event: FlowEvent): TreeInput => ({
  _tag: "Event",
  at: t0 + seconds * 1_000,
  event
})

const fold = (inputs: ReadonlyArray<TreeInput>, state: TreeState = emptyTree()): TreeState =>
  inputs.reduce(reduceTree, state)

const frame = (state: TreeState, width = 90): ReadonlyArray<string> =>
  renderTree(state, { width, colour: false, view: initialView })

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

/** The frame against its golden file; `UPDATE_GOLDENS=1` rewrites the file first. */
const golden = (name: string, width: number, view: TreeView, state: TreeState): void => {
  const rendered = `${renderTree(state, { width, colour: false, view }).join("\n")}\n`
  if (process.env.UPDATE_GOLDENS === "1") {
    writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), rendered)
  }
  assert.strictEqual(rendered, fixture(name))
}

const traceInputs = (name: string): ReadonlyArray<TreeInput> =>
  treeInputsOfTrace(
    fixture(name)
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))(line))
  )

/** A run with clones, task plans, a sub-agent, a pause, a borrowed judge and board moves (ADR 0033). */
const clonesRun = (): TreeState =>
  fold(traceInputs("agent-tree.clones.trace.jsonl"), emptyTree({ title: "epic bank-login" }))

const fixtureRun = (): TreeState =>
  fold(
    treeInputsOfTrace(
      fixture("agent-tree.trace.jsonl")
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))(line))
    ),
    emptyTree({
      title: "epic conto-bonifico",
      stories: [
        { id: "accounts", status: "done" },
        { id: "payments", status: "active" },
        { id: "iban", status: "failed" },
        { id: "overview", status: "active" },
        { id: "movimenti", status: "planned" },
        { id: "bonifico", status: "waiting" }
      ]
    })
  )

describe("agent tree", () => {
  it("draws the fixture run as its golden frames", () => {
    const state = fixtureRun()
    golden("agent-tree.lanes-90.txt", 90, initialView, state)
    golden("agent-tree.lanes-120.txt", 120, initialView, state)
    golden("agent-tree.executors-90.txt", 90, { ...initialView, mode: "executors" }, state)
  })

  it("draws the clones fixture as its golden frames, with a detail box for the latest lane", () => {
    golden("agent-tree.clones-120.txt", 120, initialView, clonesRun())
    golden("agent-tree.clones-90.txt", 90, initialView, clonesRun())
    golden("agent-tree.boards-90.txt", 90, { ...initialView, mode: "boards" }, clonesRun())
  })

  it("keeps a list line's timer and tokens at the 90-column floor, cutting the middle", () => {
    const lines = renderTree(clonesRun(), { width: 90, colour: false, view: initialView })
    const s03 = lines.find((line) => line.includes("◐ S03 claude#1")) ?? ""
    assert.match(s03, /· 20s · 0 tok\s*$/u)
    assert.include(s03, "…")
    const child = lines.find((line) => line.includes("└ sub-agent")) ?? ""
    assert.match(child, /· \d+s\s*$/u)
  })

  it("keeps a Codex sub-agent open past spawn_agent and ends it on wait or close", () => {
    const spawned = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, ToolUse.make({ lane: "S01", tool: "spawn_agent", args: "write tests" })),
      at(
        2,
        Timed.make({
          lane: "S01",
          kind: "tool",
          label: "spawn_agent",
          category: "delegate",
          ms: 10
        })
      ),
      at(3, ToolUse.make({ lane: "S01", tool: "wait", args: "t1" })),
      at(
        4,
        Timed.make({ lane: "S01", kind: "tool", label: "wait", category: "delegate", ms: 5000 })
      )
    ])
    const lane = spawned.lanes[0]
    assert.strictEqual(lane?.children.length, 1)
    assert.isTrue(lane?.children[0]?.ended)
    const open = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, ToolUse.make({ lane: "S01", tool: "spawn_agent", args: "write tests" })),
      at(
        2,
        Timed.make({
          lane: "S01",
          kind: "tool",
          label: "spawn_agent",
          category: "delegate",
          ms: 10
        })
      )
    ])
    assert.isFalse(open.lanes[0]?.children[0]?.ended)
  })

  it("selects the most recently changed lane by default and switches to the boards by key", () => {
    const state = clonesRun()
    assert.strictEqual(state.lastChanged, "S01")
    assert.strictEqual(selectedLane(state, initialView)?.id, "S01")
    const down = onTreeKey(initialView, "down", state)
    assert.strictEqual(down !== "quit" && down.selected, "S02")
    const boards = onTreeKey(initialView, "b", state)
    assert.strictEqual(boards !== "quit" && boards.mode, "boards")
    const back = boards === "quit" ? initialView : onTreeKey(boards, "b", state)
    assert.strictEqual(back !== "quit" && back.mode, "lanes")
  })

  it("fits a short terminal by shortening the agent list before the log", () => {
    const state = clonesRun()
    const full = renderTree(state, { width: 120, colour: false, view: initialView })
    const lines = renderTree(state, {
      width: 120,
      colour: false,
      view: initialView,
      height: full.length - 2
    })
    assert.strictEqual(lines.length, full.length - 2)
    assert.strictEqual(lines.filter((line) => /^│ \d\d:\d\d:\d\d /u.test(line)).length, 5)
    assert.isTrue(lines.some((line) => line.includes("… 3 more")))
    assert.isTrue(lines.some((line) => line.includes("▸ ◐ S01")))
    assert.isTrue(lines.at(-1)?.includes("run [live]") ?? false)
  })

  it("fits a short terminal by shrinking the log first, then dropping it", () => {
    const state = fixtureRun()
    const full = renderTree(state, { width: 90, colour: false, view: initialView })
    const at = (height: number) =>
      renderTree(state, { width: 90, colour: false, view: initialView, height })
    const logRows = (lines: ReadonlyArray<string>) =>
      lines.filter((line) => /^│ \d\d:\d\d:\d\d /u.test(line)).length
    const lanesAndStatus = (lines: ReadonlyArray<string>) => {
      assert.strictEqual(lines.filter((line) => line.includes("│ ◐ running")).length, 1)
      assert.include(lines.at(-2) ?? "", "stories [1/6 done")
      assert.include(lines.at(-1) ?? "", "run [live]")
    }
    assert.strictEqual(logRows(full), 5)
    assert.deepStrictEqual(at(full.length), full)

    const shrunk = at(full.length - 3)
    assert.strictEqual(shrunk.length, full.length - 3)
    assert.strictEqual(logRows(shrunk), 2)
    assert.include(shrunk.join("\n"), "codex → coder · overview")
    lanesAndStatus(shrunk)

    const oneLine = at(full.length - 4)
    assert.strictEqual(logRows(oneLine), 1)
    lanesAndStatus(oneLine)

    const noLog = at(full.length - 5)
    assert.isAtMost(noLog.length, full.length - 5)
    assert.notInclude(noLog.join("\n"), "session log")
    lanesAndStatus(noLog)

    // Shorter still: cut from the middle, the status lines stay.
    const cut = at(12)
    assert.strictEqual(cut.length, 12)
    assert.include(cut.at(-1) ?? "", "run [live]")
  })

  it("colours a frame without changing its text", () => {
    const state = fixtureRun()
    const plain = renderTree(state, { width: 90, colour: false, view: initialView })
    const coloured = renderTree(state, { width: 90, colour: true, view: initialView })
    assert.isTrue(coloured.some((line) => line.includes("\u001b[")))
    assert.deepStrictEqual(
      // eslint-disable-next-line no-control-regex
      coloured.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")),
      plain
    )
  })

  it("draws every line of a frame at exactly the terminal width", () => {
    for (const width of [90, 120]) {
      const lines = frame(emptyTree(), width)
      assert.isAbove(lines.length, 10)
      for (const line of lines) {
        assert.strictEqual([...line].length, width, JSON.stringify(line))
      }
      const titled = lines.find((line) => line.includes("┌─ session log"))
      assert.isTrue(titled?.endsWith("┐"), titled)
    }
  })

  it("shows a running story as a lane box with its executor", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(5, StageStarted.make({ stage: "story home: setup", lane: "home", executor: "codex" }))
    ])
    const text = frame(state).join("\n")
    assert.include(text, "▸ ◐ home codex")
    assert.include(text, "┌─ home · codex")
    assert.include(text, "│ stage  story home: setup")
    assert.include(text, "◐ home")
    assert.notInclude(text, "no stories in flight")
  })

  it("turns finished stories into chips and logs a failure with its reason", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(1, StageStarted.make({ stage: "story iban", lane: "iban" })),
      at(60, StageCompleted.make({ stage: "story home", lane: "home" })),
      at(
        75,
        StageFailed.make({
          stage: "story iban",
          lane: "iban",
          message: "pi error: Connection error."
        })
      )
    ])
    const text = frame(state).join("\n")
    assert.include(text, "no stories in flight")
    assert.include(text, "✓ home  ✗ iban")
    assert.include(text, "│ 00:01:15  iban")
    assert.include(text, "failed · pi error: Connection error.")
    assert.include(text, "stories [1/2 done · 0 running · 1 failed · 0 waiting]")
  })

  it("counts tokens and estimated cost per lane and for the run, and shows the last tool", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(1, ToolUse.make({ tool: "bash", args: "pnpm test", lane: "home", executor: "claude" })),
      at(
        2,
        TokensUsed.make({
          agent: "coder",
          model: "claude-sonnet-4-5",
          usage: TokenUsage.make({ prompt: 1_000_000, completion: 100_000, total: 1_100_000 }),
          lane: "home"
        })
      ),
      at(
        3,
        TokensUsed.make({
          agent: "judgment",
          model: "local-qwen",
          usage: TokenUsage.make({ prompt: 400, completion: 100, total: 500 })
        })
      )
    ])
    const text = frame(state).join("\n")
    assert.include(text, "│ 2s · bash pnpm test")
    assert.include(text, "│ 3s · 1.1M tok · ~$4.50")
    assert.include(text, "tokens [1.1M]  cost [~$4.50]")
  })

  it("lists every running lane and shows every board story as a chip", () => {
    const board = emptyTree({
      title: "epic conto-bonifico",
      stories: [
        { id: "a", status: "done" },
        { id: "b", status: "planned" },
        { id: "c", status: "planned" },
        { id: "d", status: "planned" },
        { id: "e", status: "planned" },
        { id: "f", status: "waiting" }
      ]
    })
    const state = fold(
      ["b", "c", "d", "e"].map((id, index) =>
        at(index, StageStarted.make({ stage: `story ${id}`, lane: id, executor: `x${index}` }))
      ),
      board
    )
    const lines = frame(state)
    for (const id of ["b", "c", "d", "e"]) {
      assert.isTrue(
        lines.some((line) => line.includes(`◐ ${id} x`)),
        `${id} is listed`
      )
    }
    assert.isTrue(lines.some((line) => line.includes("agents · 4 running")))
    assert.include(lines.join("\n"), "✓ a  ◐ b  ◐ c  ◐ d  ◐ e  ◌ f")
    assert.include(lines.join("\n"), "epic conto-bonifico")
    assert.include(lines.join("\n"), "stories [1/6 done · 4 running · 0 failed · 1 waiting]")
  })

  it("reads a trace, skipping kinds it does not know and ending at RunEnded", () => {
    const line = (seq: number, kind: string, fields: Record<string, string>) =>
      TraceLine.make({ schemaVersion: 1, seq, timestamp: t0 + seq, runId: "run-1", kind, fields })
    const inputs = treeInputsOfTrace([
      line(0, "StageStarted", {
        event: JSON.stringify({ _tag: "StageStarted", stage: "story home", lane: "home" })
      }),
      line(1, "RawLine", { line: "{}" }),
      line(2, "ExecutorTeleported", { event: JSON.stringify({ _tag: "ExecutorTeleported" }) }),
      line(3, "Info", { event: "not json" }),
      line(4, "RunEnded", { outcome: "completed" })
    ])
    assert.deepStrictEqual(
      inputs.map((input) => [input._tag, input.at]),
      [
        ["Event", t0],
        ["RunEnded", t0 + 4]
      ]
    )
    const ended = fold(inputs)
    assert.strictEqual(ended.ended, "completed")
  })

  it("switches the lanes to one column per executor", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "codex" })),
      at(1, StageStarted.make({ stage: "story iban", lane: "iban", executor: "claude" })),
      at(9, StageCompleted.make({ stage: "story iban", lane: "iban" }))
    ])
    const text = renderTree(state, {
      width: 90,
      colour: false,
      view: { ...initialView, mode: "executors" }
    }).join("\n")
    assert.include(text, "│ codex")
    assert.include(text, "│ coder · home")
    assert.include(text, "│ ◐ busy")
    assert.include(text, "│ claude")
    assert.include(text, "│ ○ idle")
    assert.notInclude(text, "◐ running")
  })

  it("selects and expands a lane, switches mode, toggles the log and quits by key", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "codex" })),
      at(1, StageStarted.make({ stage: "story iban", lane: "iban", executor: "claude" })),
      at(2, StageStarted.make({ stage: "story iban: setup", lane: "iban" })),
      at(3, ToolUse.make({ tool: "read", args: "src/a.ts", lane: "iban" })),
      at(4, ToolUse.make({ tool: "bash", args: "pnpm test", lane: "iban" }))
    ])
    const press = (...keys: ReadonlyArray<string>): TreeView | "quit" =>
      keys.reduce<TreeView | "quit">(
        (view, key) => (view === "quit" ? view : onTreeKey(view, key, state)),
        initialView
      )
    const viewAfter = (...keys: ReadonlyArray<string>): TreeView => {
      const view = press(...keys)
      if (view === "quit") {
        return assert.fail(`quit after ${keys.join(" ")}`)
      }
      return view
    }
    const draw = (view: TreeView) =>
      renderTree(state, { width: 90, colour: false, view }).join("\n")

    assert.strictEqual(viewAfter("1", "down").selected, "iban")
    assert.strictEqual(viewAfter("2").selected, "iban")
    assert.include(draw(viewAfter("2")), "▸ ◐ iban claude")
    assert.include(draw(viewAfter("1")), "▸ ◐ home codex")

    const expanded = draw(viewAfter("2", "enter"))
    assert.include(expanded, "┌─ iban · claude")
    assert.include(expanded, "│ story iban: setup")
    assert.include(expanded, "│   read src/a.ts")
    assert.include(expanded, "│   bash pnpm test")
    assert.notInclude(expanded, "│ home")

    assert.isFalse(viewAfter("2", "enter", "escape").expanded)
    assert.strictEqual(viewAfter("e").mode, "executors")
    assert.isTrue(viewAfter("l").fullLog)
    assert.strictEqual(press("q"), "quit")
    assert.strictEqual(press("x"), initialView)
  })

  it("logs story milestones and run-wide notes, and shows how busy the roster is", () => {
    const state = fold([
      at(0, Info.make({ message: "story plan: 2 stories" })),
      at(1, StageStarted.make({ stage: "story home", lane: "home", executor: "codex" })),
      at(2, StageStarted.make({ stage: "story iban", lane: "iban", executor: "claude" })),
      at(3, Info.make({ message: "review round 1: 3 issue(s), fixing", lane: "home" })),
      at(4, Info.make({ message: "story home: merged into epic/x", lane: "home" })),
      at(5, StageCompleted.make({ stage: "story home", lane: "home" }))
    ])
    const text = frame(state).join("\n")
    assert.include(text, "│ 00:00:00  flow             story plan: 2 stories")
    assert.include(text, "│ 00:00:04  home             merged into epic/x")
    assert.include(text, "│ 00:00:05  home             done")
    assert.notInclude(text, "review round 1")
    assert.include(text, "roster [1/2 busy]")
    assert.include(text, "│ 3s · 0 tok")
    assert.notInclude(text, "~$0.00 ")
  })

  it("puts roster leases on lanes, executor columns and the judge seat", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(1, ExecutorLeased.make({ executor: "codex", role: "coder", label: "home" })),
      at(2, ExecutorLeased.make({ executor: "claude", role: "reviewer", label: "home" })),
      at(3, ExecutorReleased.make({ executor: "claude", role: "reviewer", label: "home" })),
      at(4, ExecutorLeased.make({ executor: "claude", role: "reviewer", label: "home" })),
      at(5, ExecutorLeased.make({ executor: "claude", role: "judge", label: "home" })),
      at(6, ExecutorExcluded.make({ executor: "lemonade", reason: "until 10:05: engine down" })),
      at(7, ExecutorResumed.make({ executor: "lemonade", why: "health" })),
      at(8, ExecutorExcluded.make({ executor: "pi", reason: "for this run: not logged in" })),
      at(
        9,
        ExecutorHandedOver.make({
          from: "codex",
          role: "coder",
          label: "home",
          reason: "until 11:00: usage limit",
          scope: "coder"
        })
      )
    ])
    const lanes = frame(state).join("\n")
    assert.include(lanes, "┌─ home · codex")
    assert.include(lanes, "│    claude · on call    │")
    assert.include(lanes, "│ reviews            2   │")
    assert.include(lanes, "│ verdicts           1   │")
    assert.include(lanes, "roster           codex → coder · home")
    assert.include(lanes, "roster           lemonade back · health")
    assert.include(lanes, "roster           pi out · for this run: not logged in")
    assert.include(lanes, "roster           home: coder leaves codex · until 11:00: usage limit")
    assert.notInclude(lanes, "claude → reviewer")

    const executors = renderTree(state, {
      width: 120,
      colour: false,
      view: { ...initialView, mode: "executors" }
    }).join("\n")
    assert.include(executors, "│ coder · home")
    assert.include(executors, "│ judge · home")
    assert.include(executors, "│ ✗ out: for this … │")
    assert.include(executors, "│ ○ idle")
  })

  it("shows the latest story verdict's scores, typed judgments, and the judge's last word", () => {
    const observed = (key: string, certainty: number, decision: "act" | "caution" | "hold") =>
      JudgmentObserved.make({
        consumer: "story-board",
        key,
        state: "diff",
        question: truth(`${key}?`),
        answer: truthAnswer(certainty, origins.fake()),
        judgmentIdentity: "fake:test",
        decision,
        certainty,
        support: 1,
        origin: origins.fake(),
        outcome: { _tag: "StoryBoard", dimension: key, score: 2, mergeable: true },
        mode: "observe"
      })
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home" })),
      at(
        5,
        StoryJudged.make({
          lane: "home",
          round: 1,
          cleared: false,
          issues: 1,
          dimensions: [
            { id: "house-style", score: 2, max: 2 },
            { id: "tests", score: 1, max: 2 }
          ]
        })
      ),
      at(9, observed("scope", 0.96, "act")),
      at(10, observed("tests", 0.5, "hold"))
    ])
    const text = frame(state).join("\n")
    assert.include(text, "┌─ JUDGMENT · home r1")
    assert.include(text, "│ house-style     ██████████  2/2")
    assert.include(text, "│ tests           █████░░░░░  1/2")
    assert.include(text, "│ scope           ██████████  0.96 act")
    assert.include(text, "│ tests           █████░░░░░  0.50 hold")
    assert.include(text, "│ 1 issue → coder")
    assert.include(text, "│ » home r1: 1 issue")
    assert.include(text, "judge            home r1 · 1 issue → coder")

    const cleared = frame(
      fold(
        [
          at(
            20,
            StoryJudged.make({ lane: "home", round: 2, cleared: true, issues: 0, dimensions: [] })
          )
        ],
        state
      )
    ).join("\n")
    assert.include(cleared, "│ » home r2: cleared")
    assert.include(cleared, "judge            home r2 · cleared → merge")
  })

  it("keeps an older trace's roster lease lines out of the log, but not its other roster notes", () => {
    const state = fold([
      at(0, Info.make({ message: "roster: claude takes judge for home" })),
      at(1, Info.make({ message: "roster: codex out of the round for this run: not logged in" }))
    ])
    const text = frame(state).join("\n")
    assert.notInclude(text, "takes judge")
    assert.include(
      text,
      "│ 00:00:01  roster           codex out of the round for this run: not logged in"
    )
  })

  it("shows what a lane is doing and for how long, and marks it idle when nothing happens", () => {
    const tick = (seconds: number): TreeInput => ({ _tag: "Tick", at: t0 + seconds * 1_000 })
    const start = fold(
      [
        at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "gemini" })),
        at(10, ToolUse.make({ tool: "bash", args: "pnpm test", lane: "home" }))
      ],
      emptyTree({ idleAfterMs: 120_000 })
    )
    const running = frame(fold([tick(10 + 4 * 60 + 12)], start)).join("\n")
    assert.include(running, "│ 4m12s · bash pnpm test")
    assert.notInclude(running, "idle")

    const after = fold(
      [
        at(300, Timed.make({ kind: "tool", label: "bash", ms: 290_000, lane: "home" })),
        tick(300 + 6 * 60)
      ],
      start
    )
    const idle = frame(after).join("\n")
    assert.include(idle, "│ ⏸ idle 6m00s")
    assert.include(idle, "│ 6m00s · thinking")
  })

  it("shows work under way with its time, so a long gate reads as running, not idle", () => {
    const tick = (seconds: number): TreeInput => ({ _tag: "Tick", at: t0 + seconds * 1_000 })
    const start = fold(
      [
        at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "gemini" })),
        at(5, Began.make({ kind: "gate", label: "pnpm test", lane: "home" }))
      ],
      emptyTree({ idleAfterMs: 120_000 })
    )
    const gating = frame(fold([tick(5 + 14 * 60)], start)).join("\n")
    assert.include(gating, "│ 14m00s · pnpm test")
    assert.include(gating, "│ ◐ running")
    assert.notInclude(gating, "idle")

    // The gate ends; the coder's call opens and says nothing for a while.
    const calling = fold(
      [
        at(900, Timed.make({ kind: "gate", label: "pnpm test", ms: 895_000, lane: "home" })),
        at(901, Began.make({ kind: "model", label: "coder", lane: "home" })),
        tick(901 + 5 * 60)
      ],
      start
    )
    const quiet = frame(calling).join("\n")
    assert.include(quiet, "│ 5m00s · coder call")
    assert.include(quiet, "│ ⏸ quiet 5m00s · coder call open")

    // The call ends with nothing else under way: idle, as before.
    const done = frame(
      fold(
        [
          at(1300, Timed.make({ kind: "model", label: "coder", ms: 399_000, lane: "home" })),
          tick(1300 + 3 * 60)
        ],
        calling
      )
    ).join("\n")
    assert.include(done, "│ ⏸ idle 3m00s")
  })

  it("shows the run's own work under way outside any story", () => {
    const tick = (seconds: number): TreeInput => ({ _tag: "Tick", at: t0 + seconds * 1_000 })
    const state = fold([at(0, Began.make({ kind: "gate", label: "pnpm build" })), tick(75)])
    assert.include(frame(state).join("\n"), "now    1m15s · pnpm build")
    const ended = fold(
      [at(80, Timed.make({ kind: "gate", label: "pnpm build", ms: 80_000 })), tick(81)],
      state
    )
    assert.notInclude(frame(ended).join("\n"), "now    ")
  })

  it("adds up a lane's turns and gates, and splits the run's timed work", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "gemini" })),
      at(100, Timed.make({ kind: "model", label: "coder", ms: 90_000, lane: "home" })),
      at(300, Timed.make({ kind: "model", label: "coder", ms: 110_000, lane: "home" })),
      at(600, Timed.make({ kind: "gate", label: "pnpm test", ms: 300_000, lane: "home" })),
      at(700, Timed.make({ kind: "wait", label: "merge lock", ms: 100_000, lane: "home" }))
    ])
    const text = frame(state).join("\n")
    assert.include(text, "│ turns 2 · avg 1m40s · gates 5m00s")
    assert.include(text, "time [model 33% · tools 0% · gates 50% · wait 17%]")
  })

  it("reads the idle threshold from LLM4TS_IDLE_AFTER", () => {
    assert.strictEqual(idleAfterFrom({}), 120_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "5m" }), 300_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "90s" }), 90_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "1h" }), 3_600_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "soon" }), 120_000)
  })

  it("opens a tail on the selected story or executor, filters it by role, and closes it", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story home", lane: "home", executor: "gemini" })),
      at(1, StageStarted.make({ stage: "story iban", lane: "iban", executor: "claude" }))
    ])
    const press = (view: TreeView, ...keys: ReadonlyArray<string>): TreeView =>
      keys.reduce<TreeView>((current, key) => {
        const next = onTreeKey(current, key, state)
        return next === "quit" ? current : next
      }, view)
    // Nothing selected: nothing to tail.
    // With a lane followed by default, `t` tails it straight away.
    assert.isTrue(press(initialView, "t").tail)
    const onStory = press(initialView, "2", "t")
    assert.isTrue(onStory.tail)
    assert.deepStrictEqual(tailTargetOf(onStory), { lane: "iban" })
    assert.deepStrictEqual(
      [
        press(onStory, "r").tailRole,
        press(onStory, "r", "r").tailRole,
        press(onStory, "r", "r", "r", "r").tailRole
      ],
      ["coder", "reviewer", undefined]
    )
    assert.isFalse(press(onStory, "escape").tail)
    // In the executors view the arrows pick an executor.
    const onExecutor = press(initialView, "e", "down", "down", "t")
    assert.deepStrictEqual(tailTargetOf(onExecutor), { executor: "claude" })

    const text = renderTree(state, {
      width: 90,
      colour: false,
      view: onStory,
      tail: ["── 00:00:00 coder · claude ──", "◀ working on it"]
    }).join("\n")
    assert.include(text, "┌─ tail · iban · all")
    assert.include(text, "│ ◀ working on it")
    assert.notInclude(text, "◐ running")
    const none = renderTree(state, { width: 90, colour: false, view: onStory }).join("\n")
    assert.include(none, "no transcript for this run")
  })

  it("scrolls the tail back with page up, and back to the end with page down", () => {
    const state = fold([at(0, StageStarted.make({ stage: "story home", lane: "home" }))])
    const step = (view: TreeView, key: string): TreeView => {
      const next = onTreeKey(view, key, state)
      return next === "quit" ? view : next
    }
    const open = step(step(initialView, "1"), "t")
    assert.strictEqual(open.tailBack, 0)
    assert.strictEqual(step(step(open, "pageup"), "pageup").tailBack, 20)
    assert.strictEqual(step(step(step(open, "pageup"), "pagedown"), "pagedown").tailBack, 0)
    assert.strictEqual(step(step(open, "pageup"), "escape").tailBack, 0)
  })
})

describe("agent tree reducer (ADR 0033)", () => {
  it("puts the coder's clone on its lane and counts a borrowed judge", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, ExecutorLeased.make({ executor: "codex", role: "coder", label: "S01", clone: 2 })),
      at(
        2,
        ExecutorLeased.make({
          executor: "codex",
          role: "judge",
          label: "S01",
          borrowed: true,
          because: "nobody"
        })
      )
    ])
    assert.strictEqual(state.lanes[0]?.clone, 2)
    assert.strictEqual(state.leases[0]?.clone, 2)
    assert.strictEqual(state.judge.borrowed, 1)
    assert.strictEqual(state.lastChanged, "S01")
  })

  it("keeps the task checklist, the running task and board moves", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(
        1,
        TasksPlanned.make({
          lane: "S01",
          tasks: [
            { title: "route", completed: true, satisfies: [1] },
            { title: "cookie", completed: false, satisfies: [2] }
          ]
        })
      ),
      at(2, TaskStarted.make({ lane: "S01", index: 2, count: 2, title: "cookie", satisfies: [2] })),
      at(3, StoryStatusChanged.make({ id: "S02", status: "waiting" })),
      at(4, TaskCompleted.make({ lane: "S01", index: 2, count: 2, title: "cookie" }))
    ])
    const lane = state.lanes[0]
    assert.deepStrictEqual(
      lane?.tasks.map((task) => [task.index, task.done]),
      [
        [1, true],
        [2, true]
      ]
    )
    assert.isUndefined(lane?.task)
    assert.strictEqual(state.stories.find((story) => story.id === "S02")?.status, "waiting")
    const mid = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(2, TaskStarted.make({ lane: "S01", index: 2, count: 5, title: "cookie", satisfies: [2] }))
    ])
    assert.deepStrictEqual(mid.lanes[0]?.task, {
      index: 2,
      count: 5,
      title: "cookie",
      satisfies: [2]
    })
    assert.deepStrictEqual(
      mid.lanes[0]?.tasks.map((task) => [task.index, task.done]),
      [[2, false]]
    )
  })

  it("nests a harness sub-agent under its lane and keeps a parentless tool on the lane", () => {
    const state = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, ToolUse.make({ lane: "S01", tool: "Agent", args: "Explore: find x" })),
      at(2, ToolUse.make({ lane: "S01", tool: "Read", args: "x.ts", parent: "a1" })),
      at(3, ToolUse.make({ lane: "S01", tool: "Edit", args: "y.ts" }))
    ])
    const lane = state.lanes[0]
    assert.strictEqual(lane?.children.length, 1)
    assert.strictEqual(lane?.children[0]?.tool, "Agent")
    assert.strictEqual(lane?.children[0]?.lastTool, "Read x.ts")
    assert.strictEqual(lane?.lastTool, "Edit y.ts")
    const ended = fold(
      [
        at(
          4,
          Timed.make({ lane: "S01", kind: "tool", label: "Agent", category: "delegate", ms: 3000 })
        )
      ],
      state
    )
    assert.isTrue(ended.lanes[0]?.children[0]?.ended)
    const orphan = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, ToolUse.make({ lane: "S01", tool: "Read", args: "x.ts", parent: "ghost" }))
    ])
    assert.strictEqual(orphan.lanes[0]?.children.length, 0)
    assert.strictEqual(orphan.lanes[0]?.lastTool, "Read x.ts")
  })

  it("shows a harness pause as the lane's state while it lasts", () => {
    const paused = fold([
      at(0, StageStarted.make({ stage: "story S01", lane: "S01" })),
      at(1, Began.make({ lane: "S01", kind: "wait", label: "pi compaction" }))
    ])
    assert.deepStrictEqual(paused.lanes[0]?.pause, { label: "pi compaction", since: t0 + 1000 })
    const over = fold(
      [at(2, Timed.make({ lane: "S01", kind: "wait", label: "pi compaction", ms: 1000 }))],
      paused
    )
    assert.isUndefined(over.lanes[0]?.pause)
  })
})
