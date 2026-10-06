import { assert, describe, it } from "@effect/vitest"
import {
  PortEntry,
  asAddedFileDiff,
  batchesOf,
  linesOf,
  portStatusIn,
  renderPilotReport,
  targetPathOf
} from "@llm4ts/flow/Port"
import { QueueOutcome } from "@llm4ts/flow/WorkQueue"

describe("port helpers (ADR 0028)", () => {
  it("renders the target path from the template", () => {
    assert.strictEqual(
      targetPathOf("{{dir}}/{{base}}.rs", "src/bun.js/webcore/body.zig"),
      "src/bun.js/webcore/body.rs"
    )
    assert.strictEqual(targetPathOf("{{dir}}/{{base}}.rs", "main.zig"), "main.rs")
    assert.strictEqual(targetPathOf("ts/{{path}}.ts", "a/b.scala"), "ts/a/b.scala.ts")
    assert.strictEqual(targetPathOf("{{dir}}/{{base}}.{{ext}}.md", "a/b.scala"), "a/b.scala.md")
  })

  it("batches contiguously, small when led by a big file", () => {
    const entry = (id: string, loc: number) =>
      PortEntry.make({ id, source: id, target: `${id}.rs`, loc })
    const entries = [
      entry("a", 10),
      entry("b", 10),
      entry("c", 3000),
      entry("d", 10),
      entry("e", 10)
    ]
    const batches = batchesOf(entries, { files: 2, bigLoc: 2200, small: 1 })
    assert.deepStrictEqual(
      batches.map((batch) => batch.map((item) => item.id)),
      [["a", "b"], ["c"], ["d", "e"]]
    )
    assert.strictEqual(linesOf("a\n\nb\n"), 2)
  })

  it("reads the PORT STATUS trailer in any comment syntax; none means undefined", () => {
    const rust = [
      "fn main() {}",
      "",
      "// PORT STATUS",
      "// source: main.zig",
      "// confidence: medium",
      "// todos: 2",
      "// notes: comptime loop unrolled by hand"
    ].join("\n")
    assert.deepStrictEqual(portStatusIn(rust), {
      confidence: "medium",
      todos: 2,
      notes: "comptime loop unrolled by hand"
    })
    const block = "/* PORT STATUS\n   confidence: HIGH\n   todos: 0\n   notes: none */"
    assert.deepStrictEqual(portStatusIn(block), { confidence: "high", todos: 0, notes: "none" })
    assert.deepStrictEqual(portStatusIn("fn main() {}"), {
      confidence: undefined,
      todos: undefined,
      notes: undefined
    })
  })

  it("the pilot report measures, extrapolates and ends in the approval line", () => {
    const outcome = (id: string, status: "done" | "failed", confidence?: "high" | "low") =>
      QueueOutcome.make({
        id,
        round: 1,
        status,
        ms: 60_000,
        at: 0,
        ...(confidence === undefined ? {} : { confidence }),
        todos: 1
      })
    const report = renderPilotReport({
      outcomes: [
        outcome("a.zig", "done", "high"),
        outcome("b.zig", "done", "low"),
        outcome("c.zig", "failed")
      ],
      piloted: 3,
      remaining: 30,
      elapsedMs: 6 * 60_000,
      estimatedCostUsd: 0.9
    })
    assert.include(report, "piloted: 3 file(s), 2 done, 1 failed, in 6.0 min")
    assert.include(report, "1 high, 0 medium, 1 low; 2 TODO(port)")
    assert.include(report, "~$0.300 per file")
    assert.include(report, "remaining: 30 file(s) → about 60.0 min at this rate and ~$9.00")
    assert.include(report, "- c.zig")
    assert.isTrue(report.trimEnd().endsWith("- [ ] Approved"))
  })

  it("renders a new file as an all-additions diff", () => {
    const diff = asAddedFileDiff("src/a.rs", "fn a() {}\n")
    assert.include(diff, "+++ b/src/a.rs")
    assert.include(diff, "+fn a() {}")
  })
})
