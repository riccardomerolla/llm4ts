import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
  StageCompleted,
  StageFailed,
  Info,
  StageStarted,
  TokensUsed,
  ToolUse,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import { TokenUsage } from "@llm4ts/core/Models"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  emptyTree,
  initialView,
  onTreeKey,
  reduceTree,
  renderTree,
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
    const golden = (name: string, width: number, view: TreeView) =>
      assert.strictEqual(
        `${renderTree(state, { width, colour: false, view }).join("\n")}\n`,
        fixture(name)
      )
    golden("agent-tree.lanes-90.txt", 90, initialView)
    golden("agent-tree.lanes-120.txt", 120, initialView)
    golden("agent-tree.executors-90.txt", 90, { ...initialView, mode: "executors" })
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
    assert.include(text, "│ home")
    assert.include(text, "│ codex")
    assert.include(text, "│ story home: setup")
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
    assert.include(text, "│ bash pnpm test")
    assert.include(text, "│ 3s · 1.1M tok · ~$4.50")
    assert.include(text, "tokens [1.1M]  cost [~$4.50]")
  })

  it("draws three lanes at most and shows every board story as a chip", () => {
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
    const laneTops = lines.filter((line) => line.includes("│ ◐ running")).at(0) ?? ""
    assert.strictEqual(laneTops.split("◐ running").length - 1, 3)
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

    assert.strictEqual(viewAfter("down", "down").selected, "iban")
    assert.strictEqual(viewAfter("2").selected, "iban")
    assert.include(draw(viewAfter("2")), "│ ▸ iban")

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
})
