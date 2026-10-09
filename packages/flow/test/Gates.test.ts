import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ToolError } from "@llm4ts/core/Errors"
import { ProcessResult, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  GateBaseline,
  baselineKey,
  baselinesPath,
  compactGateArtifacts,
  compactGateLog,
  failingLinesOf,
  gateLogName,
  gatesIn,
  normalizeGateOutput,
  readBaseline,
  storyGateLogDir,
  triageGates,
  writeBaseline
} from "@llm4ts/flow/Gates"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"

const vitestRed = [
  "\u001b[31m FAIL \u001b[39m src/features/counter/counter.test.ts > counter > increments",
  "AssertionError: expected 1 to be 2",
  " ❯ src/features/counter/counter.test.ts:12:5",
  "    at /Users/x/wt/a/node_modules/vitest/dist/index.js:1:1",
  "",
  " Test Files  1 failed | 3 passed (4)",
  "      Tests  1 failed | 11 passed (12)",
  "   Duration  1.42s (transform 230ms, setup 0ms)"
].join("\n")

const tscRed = [
  "/Users/x/wt/a/src/app.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "Found 1 error in src/app.ts:7"
].join("\n")

const gateIssue = (command: string, output: string): ReviewIssue =>
  ReviewIssue.make({
    severity: "Critical",
    title: `lint failed: ${command}`,
    description: output
  })

const lint = (output: string, command = "pnpm test"): ReviewResult =>
  ReviewResult.make({ issues: [gateIssue(command, output)], summary: "lint failed" })

describe("normalizeGateOutput", () => {
  it("keeps failure lines, strips colours, timings and the work-dir prefix", () => {
    assert.deepStrictEqual(normalizeGateOutput(vitestRed, ["/Users/x/wt/a"]), [
      "FAIL src/features/counter/counter.test.ts > counter > increments",
      "AssertionError: expected 1 to be 2",
      "❯ src/features/counter/counter.test.ts:12:5"
    ])
  })

  it("the same failure from a second worktree normalizes to the same lines", () => {
    const again = vitestRed.replaceAll("/Users/x/wt/a", "/Users/x/wt/b").replace("1.42s", "0.98s")
    assert.deepStrictEqual(
      normalizeGateOutput(again, ["/Users/x/wt/b"]),
      normalizeGateOutput(vitestRed, ["/Users/x/wt/a"])
    )
  })

  it("reads tsc errors as failure lines without the absolute prefix", () => {
    assert.deepStrictEqual(normalizeGateOutput(tscRed, ["/Users/x/wt/a"]), [
      "src/app.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'."
    ])
  })

  it("a timestamped line compares equal across runs", () => {
    const a = normalizeGateOutput("2026-10-06T05:00:00.000Z error: boom", [])
    const b = normalizeGateOutput("2026-10-07T18:30:12Z error: boom", [])
    assert.deepStrictEqual(a, b)
    assert.deepStrictEqual(a, ["<ts> error: boom"])
  })
})

describe("triageGates", () => {
  const roots = ["/Users/x/wt/a"]
  const baseline = GateBaseline.make({
    baseCommit: "abc",
    appDir: ".",
    commands: ["pnpm test"],
    failingLines: normalizeGateOutput(vitestRed, roots),
    recordedAt: 0
  })

  it("a failure already on the base is inherited, not blocking", () => {
    const triage = triageGates(lint(vitestRed), baseline, roots)
    assert.isTrue(triage.blocking.isClean)
    assert.deepStrictEqual(triage.newLines, [])
    assert.deepStrictEqual(triage.inherited, baseline.failingLines)
  })

  it("a second red test under the same gate blocks on the new lines only", () => {
    const output = `${vitestRed}\n FAIL  src/app.test.ts > app > boots\nAssertionError: expected true to be false`
    const triage = triageGates(lint(output), baseline, roots)
    assert.isFalse(triage.blocking.isClean)
    assert.deepStrictEqual(triage.newLines, [
      "FAIL src/app.test.ts > app > boots",
      "AssertionError: expected true to be false"
    ])
    const issue = triage.blocking.issues[0]
    assert.strictEqual(issue?.origin, "new")
    assert.include(issue?.description ?? "", "FAIL src/app.test.ts > app > boots")
    assert.notInclude(issue?.description ?? "", "counter > increments")
  })

  it("without a baseline every failure blocks and nothing is inherited", () => {
    const result = lint(vitestRed)
    const triage = triageGates(result, undefined, roots)
    assert.strictEqual(triage.blocking, result)
    assert.deepStrictEqual(triage.inherited, [])
  })

  it("a clean result stays clean and inherits nothing", () => {
    const triage = triageGates(
      ReviewResult.make({ issues: [], summary: "lint passed" }),
      baseline,
      roots
    )
    assert.isTrue(triage.blocking.isClean)
    assert.deepStrictEqual(triage.inherited, [])
  })

  it("an issue that is not a gate passes through untouched", () => {
    const perimeter = ReviewIssue.make({
      severity: "Critical",
      title: "perimeter: src/x.ts",
      description: ""
    })
    const triage = triageGates(
      ReviewResult.make({ issues: [perimeter], summary: "" }),
      baseline,
      roots
    )
    assert.deepStrictEqual(triage.blocking.issues, [perimeter])
  })

  it("a gate failure with no recognizable failing line (a hang) is kept whole", () => {
    const hang = ReviewResult.make({
      issues: [
        ReviewIssue.make({
          severity: "Critical",
          title: "lint failed: pnpm test",
          description: "gate killed: no exit after 1200 seconds (LLM4TS_GATE_TIMEOUT)",
          gateClass: "hang"
        })
      ],
      summary: "lint failed"
    })
    const triage = triageGates(hang, baseline, roots)
    assert.isFalse(triage.blocking.isClean)
    assert.strictEqual(triage.blocking.issues[0]?.gateClass, "hang")
  })
})

describe("baseline store", () => {
  it.effect("writes and reads a baseline by key in one file; a missing one reads undefined", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const key = baselineKey({ baseCommit: "abc", appDir: ".", commands: [["pnpm", "test"]] })
      assert.isUndefined(yield* readBaseline(memory.store, "/state", key))
      const baseline = GateBaseline.make({
        baseCommit: "abc",
        appDir: ".",
        commands: ["pnpm test"],
        failingLines: ["FAIL x"],
        recordedAt: 1
      })
      yield* writeBaseline(memory.store, "/state", key, baseline)
      const other = GateBaseline.make({ ...baseline, baseCommit: "abd" })
      yield* writeBaseline(memory.store, "/state", "other", other)
      assert.deepStrictEqual(yield* readBaseline(memory.store, "/state", key), baseline)
      assert.deepStrictEqual(yield* readBaseline(memory.store, "/state", "other"), other)
      assert.deepStrictEqual(Object.keys(yield* memory.files), [baselinesPath("/state")])
      assert.strictEqual(baselinesPath("/state/"), "/state/gates/baselines.json")
    })
  )

  it.effect("an unreadable baselines file reads as no baseline", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({ "/state/gates/baselines.json": "{nope" })
      assert.isUndefined(yield* readBaseline(memory.store, "/state", "k"))
    })
  )

  it("the key changes with the commit, the app dir and the commands", () => {
    const a = baselineKey({ baseCommit: "abc", appDir: ".", commands: [["pnpm", "test"]] })
    assert.notStrictEqual(
      a,
      baselineKey({ baseCommit: "abd", appDir: ".", commands: [["pnpm", "test"]] })
    )
    assert.notStrictEqual(
      a,
      baselineKey({ baseCommit: "abc", appDir: "frontend", commands: [["pnpm", "test"]] })
    )
    assert.notStrictEqual(
      a,
      baselineKey({ baseCommit: "abc", appDir: ".", commands: [["pnpm", "lint"]] })
    )
  })
})

describe("failingLinesOf", () => {
  it("collects the normalized lines of every gate issue in a result", () => {
    const result = ReviewResult.make({
      issues: [gateIssue("pnpm typecheck", tscRed), gateIssue("pnpm test", vitestRed)],
      summary: "lint failed"
    })
    assert.strictEqual(failingLinesOf(result, ["/Users/x/wt/a"]).length, 4)
  })
})

describe("gatesIn", () => {
  const exits = (byCommand: Record<string, number>) =>
    makeProcessExecutor({
      run: (argv) =>
        Effect.succeed(
          ProcessResult.make({
            stdout: [`${argv.join(" ")} said ${byCommand[argv.join(" ")] ?? 0}`],
            exitCode: byCommand[argv.join(" ")] ?? 0
          })
        ),
      runStreaming: () => Stream.empty
    })

  it.effect("stops at the first red gate and writes one log per gate that ran", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const memory = yield* makeMemoryPlainFileStore()
      const run = gatesIn(exits({ "pnpm lint": 1 }), events, [
        ["pnpm", "typecheck"],
        ["pnpm", "lint"],
        ["pnpm", "test"]
      ])
      const result = yield* run("/wt/a", undefined, {
        files: memory.store,
        dir: "/state/stories/a/gates"
      })
      assert.strictEqual(result.issues.length, 1)
      assert.strictEqual(result.issues[0]?.title, "gate failed: pnpm lint")
      assert.strictEqual(result.issues[0]?.logPath, "/state/stories/a/gates/1-pnpm-lint.log")
      assert.deepStrictEqual(Object.keys(yield* memory.files).sort(), [
        "/state/stories/a/gates/0-pnpm-typecheck.log",
        "/state/stories/a/gates/1-pnpm-lint.log"
      ])
    })
  )

  it.effect("without a log dir nothing is written and the result is the same", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const result = yield* gatesIn(exits({}), events, [["pnpm", "test"]])("/wt/a")
      assert.isTrue(result.isClean)
    })
  )

  it.effect("says each gate began before it ends, so a long one shows as running", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      yield* gatesIn(exits({}), events, [
        ["pnpm", "test"],
        ["pnpm", "build"]
      ])("/wt/a")
      const timeline = (yield* events.recorded).flatMap((event) =>
        event._tag === "Began" || event._tag === "Timed"
          ? [`${event._tag} ${event.kind} ${event.label}`]
          : []
      )
      assert.deepStrictEqual(timeline, [
        "Began gate pnpm test",
        "Timed gate pnpm test",
        "Began gate pnpm build",
        "Timed gate pnpm build"
      ])
    })
  )

  it.effect("a gate that cannot run still ends what it began", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const broken = makeProcessExecutor({
        run: () => Effect.fail(ToolError.make({ toolName: "pnpm", detail: "spawn pnpm ENOENT" })),
        runStreaming: () => Stream.empty
      })
      yield* Effect.flip(gatesIn(broken, events, [["pnpm", "test"]])("/wt/a"))
      const timeline = (yield* events.recorded).flatMap((event) =>
        event._tag === "Began" || event._tag === "Timed"
          ? [
              `${event._tag} ${event.kind} ${event.label}${event._tag === "Timed" && event.failed === true ? " failed" : ""}`
            ]
          : []
      )
      assert.deepStrictEqual(timeline, ["Began gate pnpm test", "Timed gate pnpm test failed"])
    })
  )

  it("names a log by index and command slug", () => {
    assert.strictEqual(gateLogName(2, ["pnpm", "run", "test:unit"]), "2-pnpm-run-test-unit.log")
  })
})

describe("compactGateLog and compactGateArtifacts", () => {
  it("compactGateLog keeps the failing lines only", () => {
    assert.strictEqual(
      compactGateLog(
        "\u001b[31m FAIL \u001b[39m a.test.ts > a\n    at x\n Duration 1s\nAssertionError: no",
        []
      ),
      "FAIL a.test.ts > a\nAssertionError: no"
    )
  })

  it.effect("deletes the baselines file and compacts every story's gate logs", () =>
    Effect.gen(function* () {
      const stateDir = "/repo/.llm4ts/epics/e"
      const logPath = `${storyGateLogDir(stateDir, "a")}/${gateLogName(0, ["pnpm", "test"])}`
      const memory = yield* makeMemoryPlainFileStore({
        [baselinesPath(stateDir)]: "{}",
        [logPath]: "\u001b[31m FAIL \u001b[39m a.test.ts > a\n    at x\nAssertionError: no",
        [`${stateDir}/stories/a.findings.md`]: "untouched"
      })
      const counts = yield* compactGateArtifacts(
        memory.store,
        stateDir,
        ["a", "b"],
        [["pnpm", "test"]]
      )
      assert.deepStrictEqual(counts, { baselines: 1, logs: 1 })
      const files = yield* memory.files
      assert.isUndefined(files[baselinesPath(stateDir)])
      assert.strictEqual(files[logPath], "FAIL a.test.ts > a\nAssertionError: no")
      assert.strictEqual(files[`${stateDir}/stories/a.findings.md`], "untouched")
    })
  )
})
