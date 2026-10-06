import { assert, describe, it } from "@effect/vitest"
import {
  DiffVerdict,
  GuideFinding,
  LedgerRow,
  PortEntry,
  asAddedFileDiff,
  batchesOf,
  diffVerdict,
  ledgerRowsFor,
  linesOf,
  parseLedger,
  portStatusIn,
  renderDiag,
  renderDifferentialReport,
  renderGuideAudit,
  renderLedger,
  renderPilotReport,
  standsAfterRefutes,
  targetPathOf,
  unitsIn
} from "@llm4ts/flow/Port"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
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

describe("port ledger, refutes, guide audit, differential (ADR 0028)", () => {
  it("renders and parses the ledger TSV and picks one file's rows", () => {
    const rows = [
      LedgerRow.make({
        file: "src/a.zig",
        unit: "buf",
        class: "OWNED",
        evidence: "src/a.zig:12",
        confidence: "high"
      }),
      LedgerRow.make({
        file: "src/b.zig",
        unit: "parent",
        class: "BACKREF",
        evidence: "src/b.zig:3\tweird",
        confidence: "low"
      })
    ]
    const text = renderLedger(rows)
    assert.isTrue(text.startsWith("file\tunit\tclass\tevidence\tconfidence\n"))
    const parsed = parseLedger(text)
    assert.strictEqual(parsed.length, 2)
    assert.strictEqual(parsed[1]?.evidence, "src/b.zig:3 weird")
    assert.strictEqual(ledgerRowsFor(parsed, "src/a.zig"), "- buf: OWNED (src/a.zig:12; high)")
    assert.isUndefined(ledgerRowsFor(parsed, "src/c.zig"))
  })

  it("names the units a ledger regex captures, each once", () => {
    const zig =
      "const S = struct {\n    buf: []u8,\n    parent: ?*Node,\n    count: u32,\n    buf: []u8,\n};"
    assert.deepStrictEqual(unitsIn(zig, "^\\s+(\\w+):\\s*(?:\\?\\*|\\*|\\[\\]|\\[\\*\\])"), [
      "buf",
      "parent"
    ])
    assert.deepStrictEqual(
      unitsIn("class A\nobject B\ntrait C", "^(?:class|object|trait)\\s+(\\w+)"),
      ["A", "B", "C"]
    )
  })

  it("a finding stands unless a majority refutes it", () => {
    assert.isTrue(standsAfterRefutes([true, true, false]))
    assert.isFalse(standsAfterRefutes([false, false, true]))
    assert.isTrue(standsAfterRefutes([]))
  })

  it("the guide audit renders proposed rules as diffs and ends in the approval line", () => {
    const finding = GuideFinding.make({
      dimension: "error model",
      finding: "no rule for anyerror",
      evidence: "a.zig:4",
      proposedRule: "Map anyerror!T to Result<T, Error>."
    })
    const report = renderGuideAudit({
      pack: "zig-rust",
      kept: [finding],
      dropped: [],
      trial: ["a.zig: native used Vec"],
      sample: ["a.zig"]
    })
    assert.include(report, "+ - Map anyerror!T to Result<T, Error>.")
    assert.include(report, "## Trial port")
    assert.isTrue(report.trimEnd().endsWith("- [ ] Approved"))
    assert.include(
      renderGuideAudit({ pack: "p", kept: [], dropped: [], trial: [], sample: [] }),
      "the rulebook stands"
    )
  })

  it("the differential verdict compares exit and pass counts and classifies the rest", () => {
    const green = (passed?: number) =>
      ReviewResult.make({
        issues: [],
        summary: "lint passed",
        ...(passed === undefined ? {} : { passed })
      })
    const red = (output: string, gateClass: "red" | "hang" | "crash" = "red", passed?: number) =>
      ReviewResult.make({
        issues: [
          ReviewIssue.make({
            severity: "Critical",
            title: "lint failed: x",
            description: output,
            gateClass
          })
        ],
        summary: "lint failed",
        ...(passed === undefined ? {} : { passed })
      })
    assert.strictEqual(diffVerdict("t.ts", green(2), green(2)).class, "pass")
    assert.strictEqual(diffVerdict("t.ts", green(2), green(1)).class, "diverge")
    assert.strictEqual(diffVerdict("t.ts", green(), green()).class, "pass")
    assert.strictEqual(diffVerdict("t.ts", green(2), red("boom", "red", 1)).class, "diverge")
    assert.strictEqual(diffVerdict("t.ts", green(2), red("killed", "hang")).class, "hang")
    assert.strictEqual(diffVerdict("t.ts", green(2), red("segv", "crash")).class, "crash")
    assert.strictEqual(diffVerdict("t.ts", red("legacy broken"), red("also")).class, "legacy-red")
    const verdict = diffVerdict("t.ts", green(2), red("/repo/src/x.ts failed", "red", 1), ["/repo"])
    assert.include(verdict.detail, "src/x.ts failed")
    assert.notInclude(verdict.detail, "/repo/")
    assert.include(renderDiag(verdict), "# t.ts: diverge")
    const report = renderDifferentialReport(1, [
      verdict,
      DiffVerdict.make({ file: "u.ts", class: "pass", detail: "" })
    ])
    assert.include(report, "pass 1, diverge 1")
    assert.include(report, "## diverge")
  })
})
