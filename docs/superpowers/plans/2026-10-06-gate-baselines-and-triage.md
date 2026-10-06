# Gate Baselines And Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A story is blocked only by gate failures it caused: failures already red on its base are listed, not charged; a flaky test is reported, not charged; a hung gate ends as a failure that says so; gate output lives in a file the fix round is pointed at.

**Architecture:** One new pure module `packages/flow/src/Gates.ts` (normalization, triage, baseline persistence, the moved `gatesIn`) feeds the existing seams: `lintCommand` and `reviewAndFixLoop` in `Review.ts` gain a timeout, a gate class and a `triage` option; `implementPlanFlow` applies the same triage to its final gate check; `Stories.ts` records a baseline for every epic head (run start and after every merge) and reads it per story; the shell lib `flows/lib/epic-stories.js` wires env knobs and `--land` cleanup. No new error types: a hang is a `ProcessError`-free `ReviewIssue` with `gateClass: "hang"`.

**Tech Stack:** TypeScript, Effect 4.0.0 (`Effect.gen`, `Effect.fn`, `Schema.Class`, `Schema.TaggedClass`, `Effect.timeoutOption`, `TestClock`), `@effect/vitest`, pnpm workspace. Relative imports use `.ts` extensions; new flow modules are added to `packages/flow/package.json` `exports`.

**Spec:** `specs/pending/gate-baselines-and-triage.md` (design record `docs/adr/0027-rewrite-grade-review-and-oracle.md`, decisions 1–3).

## Global Constraints

- Effect pins are exact `4.0.0`; do not touch dependency versions.
- No `any`, no unchecked type assertions, no namespaces, no global `Error` as a domain error; expected failures stay in `FlowError` (reuse `ProcessError`, `PersistenceError`; nothing new).
- Explicit subpath export for the new module: `"./Gates": "./dist/Gates.js"` in `packages/flow/package.json`.
- Tests are deterministic (`@effect/vitest`), use the in-src fakes (`makeMemoryPlainFileStore`, `makeProcessExecutor` with a hand-written `run`, the `Stories.test.ts` harness), never the network or a provider CLI.
- `ReviewIssue` gains only optional keys (`origin`, `gateClass`, `logPath`); every existing `ReviewIssue.make({...})` call compiles unchanged and every persisted review-cache JSON still decodes.
- Defaults: `LLM4TS_GATE_TIMEOUT` is seconds, default `1200`; `LLM4TS_GATE_TAIL_CHARS` default `4000`. Both read in the shell lib from `process.env` and passed as options, never read inside `@llm4ts/flow`.
- Nothing in a `Timed` event, a span or the profile carries gate output (ADR 0026 posture): logs go to files in the run state, never to the target repository.
- Verification before every commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (run `pnpm format` first).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A base branch that is already red** must let a story that does not touch the red test merge, list the red once as inherited, and still record a baseline for the new epic head. Pinned in Task 5 (`red on main, story merges` test).
2. **A story whose change makes a second test red while the first stays red** must be blocked on the second only; the fix prompt must name only the new line. Pinned in Task 3 (`triageGates` with overlapping lines) and Task 5.
3. **A gate whose output differs only in timings, colours or absolute paths between runs** must not look `new`. Pinned in Task 1 (`normalizeGateOutput` fixtures from vitest and tsc with ANSI, `12 ms`, and `/Users/x/wt/a/src/...` prefixes).
4. **A caller without a baseline** (no base commit, a repository with no commits, a flow that never passed `triage`) must behave exactly as today: every red line blocks. Pinned in Task 3 (`reviewAndFixLoop` without `triage` unchanged) and Task 6 (`implementPlanFlow` without `baseline`).
5. **A gate that never exits** must end within the timeout as a single Critical with `gateClass: "hang"`, the clock must be the Effect clock (so tests use `TestClock`), and the child process must be interrupted, not orphaned. Pinned in Task 2.

---

### Task 1: `Gates.ts` — normalization, triage, baseline schema and store

**Files:**

- Create: `packages/flow/src/Gates.ts`
- Modify: `packages/flow/package.json` (add `"./Gates": "./dist/Gates.js"` beside `"./Perimeter"`)
- Test: `packages/flow/test/Gates.test.ts`

**Interfaces:**

- Consumes: `PlainFileStoreShape` (`./Persistence.ts`), `fingerprintOf` (`./ReviewCache.ts`), `ReviewIssue`, `ReviewResult` (`./Review.ts`), `PersistenceError` (`./FlowError.ts`).
- Produces (used by Tasks 3–6):

```ts
export const GateClass = Schema.Literals(["red", "hang", "crash"])
export type GateClass = typeof GateClass.Type
export const FailureOrigin = Schema.Literals(["new", "base", "flaky"])
export type FailureOrigin = typeof FailureOrigin.Type

export class GateBaseline extends Schema.Class<GateBaseline>("GateBaseline")({
  baseCommit: Schema.String,
  appDir: Schema.String,
  commands: Schema.Array(Schema.String), // each command joined with " "
  failingLines: Schema.Array(Schema.String),
  recordedAt: Schema.Number
}) {}

export const normalizeGateOutput: (
  text: string,
  roots: ReadonlyArray<string>
) => ReadonlyArray<string>
export const failingLinesOf: (
  result: ReviewResult,
  roots: ReadonlyArray<string>
) => ReadonlyArray<string>
export interface GateTriage {
  readonly blocking: ReviewResult // the lint result with only `new` issues
  readonly newLines: ReadonlyArray<string>
  readonly inherited: ReadonlyArray<string>
}
export const triageGates: (
  result: ReviewResult,
  baseline: GateBaseline | undefined,
  roots: ReadonlyArray<string>
) => GateTriage
export const baselineKey: (parts: {
  baseCommit: string
  appDir: string
  commands: ReadonlyArray<ReadonlyArray<string>>
}) => string
export const baselinePath: (dir: string, key: string) => string // `${dir}/gates/baseline-${key}.json`
export const readBaseline: (
  files: PlainFileStoreShape,
  path: string
) => Effect.Effect<GateBaseline | undefined, PersistenceError>
export const writeBaseline: (
  files: PlainFileStoreShape,
  path: string,
  baseline: GateBaseline
) => Effect.Effect<void, PersistenceError>
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/Gates.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  GateBaseline,
  baselineKey,
  baselinePath,
  failingLinesOf,
  normalizeGateOutput,
  readBaseline,
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

describe("normalizeGateOutput", () => {
  it("keeps failure lines, strips colours, timings and the work-dir prefix", () => {
    const lines = normalizeGateOutput(vitestRed, ["/Users/x/wt/a"])
    assert.deepStrictEqual(lines, [
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
    const result = ReviewResult.make({
      issues: [gateIssue("pnpm test", vitestRed)],
      summary: "lint failed"
    })
    const triage = triageGates(result, baseline, roots)
    assert.isTrue(triage.blocking.isClean)
    assert.deepStrictEqual(triage.newLines, [])
    assert.deepStrictEqual(triage.inherited, baseline.failingLines)
  })

  it("a second red test under the same gate blocks on the new lines only", () => {
    const output = `${vitestRed}\n FAIL  src/app.test.ts > app > boots\nAssertionError: expected true to be false`
    const result = ReviewResult.make({
      issues: [gateIssue("pnpm test", output)],
      summary: "lint failed"
    })
    const triage = triageGates(result, baseline, roots)
    assert.isFalse(triage.blocking.isClean)
    assert.deepStrictEqual(triage.newLines, [
      "FAIL src/app.test.ts > app > boots",
      "AssertionError: expected true to be false"
    ])
    assert.strictEqual(triage.blocking.issues[0]?.origin, "new")
    assert.include(
      triage.blocking.issues[0]?.description ?? "",
      "FAIL src/app.test.ts > app > boots"
    )
    assert.notInclude(triage.blocking.issues[0]?.description ?? "", "counter > increments")
  })

  it("without a baseline every failure blocks and nothing is inherited", () => {
    const result = ReviewResult.make({
      issues: [gateIssue("pnpm test", vitestRed)],
      summary: "lint failed"
    })
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

  it("an issue that is not a gate (no 'lint failed' title) passes through untouched", () => {
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
})

describe("baseline store", () => {
  it.effect("writes and reads a baseline by key; a missing one reads undefined", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const key = baselineKey({ baseCommit: "abc", appDir: ".", commands: [["pnpm", "test"]] })
      const path = baselinePath("/state", key)
      assert.strictEqual(path, `/state/gates/baseline-${key}.json`)
      assert.isUndefined(yield* readBaseline(memory.store, path))
      const baseline = GateBaseline.make({
        baseCommit: "abc",
        appDir: ".",
        commands: ["pnpm test"],
        failingLines: ["FAIL x"],
        recordedAt: 1
      })
      yield* writeBaseline(memory.store, path, baseline)
      assert.deepStrictEqual(yield* readBaseline(memory.store, path), baseline)
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Gates.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/flow/Gates`; `ReviewIssue` has no `origin`.

- [ ] **Step 3: Add the `origin`, `gateClass` and `logPath` keys to `ReviewIssue`**

In `packages/flow/src/Review.ts`, inside `ReviewIssue`:

```ts
export class ReviewIssue extends Schema.Class<ReviewIssue>("ReviewIssue")({
  severity: Severity,
  title: Schema.String,
  description: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  suggestion: Schema.optionalKey(Schema.String),
  confidence: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  /** A gate failure's triage against the base (ADR 0027): absent for review findings. */
  origin: Schema.optionalKey(Schema.Literals(["new", "base", "flaky"])),
  /** How the gate ended: red exit, killed at the timeout, or a signal/crash exit. */
  gateClass: Schema.optionalKey(Schema.Literals(["red", "hang", "crash"])),
  /** Where the gate's full output was written, when a caller asked for a log. */
  logPath: Schema.optionalKey(Schema.String)
}) {}
```

`Gates.ts` imports `ReviewIssue`/`ReviewResult` from `./Review.ts`; `Review.ts` must not import `Gates.ts` at module top level in this task (Task 3 adds the import for `triageGates` — check that `Gates.ts` imports only the two classes, which creates no cycle because both are plain classes evaluated at load; if `pnpm typecheck` or vitest reports a cycle, move `GateClass`/`FailureOrigin` literals into `Review.ts` and re-export them from `Gates.ts`).

- [ ] **Step 4: Write `Gates.ts`**

```ts
// packages/flow/src/Gates.ts
// Gates with a memory (ADR 0027): the target's gate commands, what they said
// on the code a change started from, and which failing lines a change can be
// charged with. Pure helpers here; the seams are lintCommand/reviewAndFixLoop
// (Review.ts), implementPlanFlow (Flow.ts) and the story executor (Stories.ts).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { ReviewIssue, ReviewResult } from "./Review.ts"
import { fingerprintOf } from "./ReviewCache.ts"

export const GateClass = Schema.Literals(["red", "hang", "crash"])
export type GateClass = typeof GateClass.Type

export const FailureOrigin = Schema.Literals(["new", "base", "flaky"])
export type FailureOrigin = typeof FailureOrigin.Type

export class GateBaseline extends Schema.Class<GateBaseline>("GateBaseline")({
  baseCommit: Schema.String,
  appDir: Schema.String,
  /** Each gate command as configured, joined with one space. */
  commands: Schema.Array(Schema.String),
  failingLines: Schema.Array(Schema.String),
  recordedAt: Schema.Number
}) {}

const GateBaselineJson = Schema.fromJsonString(GateBaseline)
const decodeBaseline = Schema.decodeUnknownEffect(GateBaselineJson)
const encodeBaseline = Schema.encodeSync(GateBaselineJson)

const ansi = /\u001b\[[0-9;]*m/gu
const duration = /\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/gu
const isoTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/gu
const stackFrame = /^\s*at\s/u
const summaryLine = /^\s*(?:Test Files|Tests|Duration|Start at|Snapshots|Found \d+ errors?)\b/u
const failureMarker =
  /FAIL|✗|×|✘|✖|❯|error|Error|AssertionError|Expected|Received|expected|TS\d{4}/u

/**
 * The lines of a gate's output a change can be blamed for, made comparable
 * across runs and worktrees: colours, timings, timestamps and the given root
 * prefixes removed; stack frames, summaries and blank lines dropped; only
 * lines carrying a failure marker kept. A heuristic by design — per-tool
 * parsers are kit material (pack `diagnostics:`, a later phase).
 */
export const normalizeGateOutput = (
  text: string,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const prefixes = roots.filter((root) => root.length > 0).map((root) => root.replace(/\/+$/u, ""))
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.replace(ansi, "")
    for (const prefix of prefixes) {
      line = line.replaceAll(`${prefix}/`, "")
    }
    line = line.replace(isoTimestamp, "<ts>").replace(duration, "<t>").trim()
    if (line.length === 0 || stackFrame.test(line) || summaryLine.test(line)) continue
    if (!failureMarker.test(line)) continue
    line = line.replace(/\s+/gu, " ")
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

const isGateIssue = (issue: ReviewIssue): boolean => issue.title.startsWith("lint failed: ")

/** Every gate issue's normalized failing lines, in order, deduplicated. */
export const failingLinesOf = (
  result: ReviewResult,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> =>
  Array.from(
    new Set(
      result.issues
        .filter(isGateIssue)
        .flatMap((issue) => normalizeGateOutput(issue.description, roots))
    )
  )

export interface GateTriage {
  /** The lint result with only the failures the change caused; `isClean` when it caused none. */
  readonly blocking: ReviewResult
  readonly newLines: ReadonlyArray<string>
  /** Failing lines already red on the base: listed, never charged. */
  readonly inherited: ReadonlyArray<string>
}

/**
 * Splits a lint result against the baseline. A gate issue whose every
 * failing line is on the baseline is dropped (inherited); one with new lines
 * is kept with `origin: "new"` and its description reduced to those lines,
 * so the fix prompt names only what the change broke. Non-gate issues (the
 * perimeter, the oracle guard) pass through. Without a baseline the result
 * is returned as is.
 */
export const triageGates = (
  result: ReviewResult,
  baseline: GateBaseline | undefined,
  roots: ReadonlyArray<string>
): GateTriage => {
  if (baseline === undefined || result.isClean) {
    return { blocking: result, newLines: [], inherited: [] }
  }
  const known = new Set(baseline.failingLines)
  const newLines: Array<string> = []
  const inherited: Array<string> = []
  const issues: Array<ReviewIssue> = []
  for (const issue of result.issues) {
    if (!isGateIssue(issue)) {
      issues.push(issue)
      continue
    }
    const lines = normalizeGateOutput(issue.description, roots)
    const fresh = lines.filter((line) => !known.has(line))
    const old = lines.filter((line) => known.has(line))
    inherited.push(...old)
    if (fresh.length === 0 && lines.length > 0) continue
    newLines.push(...fresh)
    issues.push(
      ReviewIssue.make({
        ...issue,
        origin: "new",
        description: fresh.length > 0 ? fresh.join("\n") : issue.description
      })
    )
  }
  return {
    blocking: ReviewResult.make({
      issues,
      summary: issues.length === 0 ? "lint passed (inherited failures only)" : result.summary
    }),
    newLines: Array.from(new Set(newLines)),
    inherited: Array.from(new Set(inherited))
  }
}

export const baselineKey = (parts: {
  readonly baseCommit: string
  readonly appDir: string
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
}): string =>
  fingerprintOf([
    parts.baseCommit,
    parts.appDir,
    ...parts.commands.map((command) => command.join(" "))
  ]).slice(0, 16)

export const baselinePath = (dir: string, key: string): string =>
  join(dir, "gates", `baseline-${key}.json`)

export const readBaseline = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<GateBaseline | undefined, PersistenceError> =>
  files.read(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : decodeBaseline(text).pipe(
            // An unreadable baseline is no baseline: the caller records a fresh one.
            Effect.catch(() => Effect.succeed(undefined))
          )
    )
  )

export const writeBaseline = (
  files: PlainFileStoreShape,
  path: string,
  baseline: GateBaseline
): Effect.Effect<void, PersistenceError> => files.writeAtomic(path, encodeBaseline(baseline))
```

Check `fingerprintOf`'s signature in `ReviewCache.ts` (it takes `ReadonlyArray<string>` and returns a hex string); if it returns an `Effect`, replace the `.slice` with the same digest helper `ReviewCache.ts` uses internally and export it from there.

- [ ] **Step 5: Add the export and run the tests**

In `packages/flow/package.json` `exports`, after `"./FlowRecorder"` (keep alphabetical order as the file does): `"./Gates": "./dist/Gates.js",`.

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Gates.test.ts test/Review.test.ts test/ReviewCache.test.ts`
Expected: PASS (Review and ReviewCache unchanged: the new keys are optional).

- [ ] **Step 6: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green.

```bash
git add packages/flow/src/Gates.ts packages/flow/src/Review.ts packages/flow/package.json packages/flow/test/Gates.test.ts
git commit -m "flow: Gates — normalized failing lines, triage against a baseline, baseline store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `lintCommand` — timeout, gate class, log sink

**Files:**

- Modify: `packages/flow/src/Review.ts` (`lintCommand`, lines ~267–315)
- Test: `packages/flow/test/Review.test.ts` (new `describe("lintCommand timeout and class")`)

**Interfaces:**

- Consumes: `GateClass` from Task 1 (type only, via the literal on `ReviewIssue`).
- Produces (used by Tasks 4–5):

```ts
export interface LintCommandOptions {
  /** Kill the gate after this long; the issue is then `gateClass: "hang"`. Default: none. */
  readonly timeout?: Duration.Duration
  /** Write the gate's full stdout+stderr here; the issue carries `logPath`. */
  readonly log?: { readonly files: PlainFileStoreShape; readonly path: string }
}
export const lintCommand: (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  command: ReadonlyArray<string>,
  workDir: string,
  options?: LintCommandOptions
) => Effect.Effect<ReviewResult, FlowError>
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/flow/test/Review.test.ts` (imports already present: `Effect`, `Fiber`, `TestClock`, `ProcessResult`, `makeProcessExecutor`, `makeMemoryPlainFileStore`, `makeCollectingFlowEvents`, `lintCommand`). Add `import * as Duration from "effect/Duration"` at the top.

```ts
describe("lintCommand timeout and class", () => {
  const neverExits = makeProcessExecutor({
    run: () => Effect.never,
    runStreaming: () => Stream.empty
  })

  it.effect("a gate that never exits ends at the timeout as one Critical of class hang", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const fiber = yield* Effect.forkChild(
        lintCommand(neverExits, events, ["pnpm", "test"], "/wt/a", {
          timeout: Duration.seconds(30)
        })
      )
      yield* TestClock.adjust(Duration.seconds(31))
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.issues.length, 1)
      assert.strictEqual(result.issues[0]?.gateClass, "hang")
      assert.include(result.issues[0]?.description ?? "", "no exit after 30 seconds")
      const timed = (yield* events.recorded).find((event) => event._tag === "Timed")
      assert.strictEqual(timed?._tag === "Timed" ? timed.failed : undefined, true)
    })
  )

  it.effect("an exit code of 128 or more is class crash; a smaller non-zero exit is red", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const exits = (code: number) =>
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: ["boom"], exitCode: code })),
          runStreaming: () => Stream.empty
        })
      const crash = yield* lintCommand(exits(139), events, ["pnpm", "test"], "/wt/a")
      const red = yield* lintCommand(exits(1), events, ["pnpm", "test"], "/wt/a")
      assert.strictEqual(crash.issues[0]?.gateClass, "crash")
      assert.strictEqual(red.issues[0]?.gateClass, "red")
    })
  )

  it.effect("writes the full output to the log when asked and names the path on the issue", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const memory = yield* makeMemoryPlainFileStore()
      const process = makeProcessExecutor({
        run: () =>
          Effect.succeed(ProcessResult.make({ stdout: ["FAIL a"], stderr: ["warn"], exitCode: 1 })),
        runStreaming: () => Stream.empty
      })
      const result = yield* lintCommand(process, events, ["pnpm", "test"], "/wt/a", {
        log: { files: memory.store, path: "/state/stories/a/gates/1-pnpm-test.log" }
      })
      assert.strictEqual(result.issues[0]?.logPath, "/state/stories/a/gates/1-pnpm-test.log")
      const files = yield* memory.files
      assert.strictEqual(files["/state/stories/a/gates/1-pnpm-test.log"], "FAIL a\nwarn")
    })
  )

  it.effect("a green gate with a log sink writes the log too, so a later diff has both sides", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const memory = yield* makeMemoryPlainFileStore()
      const process = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: ["ok"], exitCode: 0 })),
        runStreaming: () => Stream.empty
      })
      yield* lintCommand(process, events, ["pnpm", "test"], "/wt/a", {
        log: { files: memory.store, path: "/state/gates/0.log" }
      })
      assert.strictEqual((yield* memory.files)["/state/gates/0.log"], "ok")
    })
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Review.test.ts -t "timeout and class"`
Expected: FAIL — `lintCommand` takes 4 arguments; `gateClass` undefined.

- [ ] **Step 3: Implement the options in `lintCommand`**

Add `import * as Duration from "effect/Duration"` to `Review.ts`. Replace the body of `lintCommand` from `const started = ...` to the end:

```ts
export interface LintCommandOptions {
  readonly timeout?: Duration.Duration
  readonly log?: { readonly files: PlainFileStoreShape; readonly path: string }
}

const gateClassOf = (exitCode: number): "red" | "crash" => (exitCode >= 128 ? "crash" : "red")

export const lintCommand = Effect.fn("@llm4ts/flow/Review.lintCommand")(function* (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  command: ReadonlyArray<string>,
  workDir: string,
  options: LintCommandOptions = {}
): Effect.fn.Return<ReviewResult, FlowError> {
  const executable = command[0]
  if (executable === undefined) {
    return ReviewResult.make({ issues: [], summary: "" })
  }
  const label = command.join(" ")
  const started = yield* Clock.currentTimeMillis
  const run = guarded(
    Capabilities.Exec(executable),
    `lint: ${label}`,
    events,
    process
      .run(command, workDir, {})
      .pipe(
        Effect.mapError((cause) => ProcessError.make({ message: label, detail: cause.message }))
      )
  )
  // Interrupting `run` interrupts the child through the executor's scope;
  // `undefined` here means the gate never exited.
  const bounded: Effect.Effect<ProcessResult | undefined, FlowError> =
    options.timeout === undefined
      ? run
      : run.pipe(
          Effect.timeoutOption(options.timeout),
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined))
        )
  // A TOOL span (ADR 0026) and a Timed event: the command as configured and
  // its exit code, never its output.
  const result = yield* withKindSpan(
    `gate ${label}`,
    { kind: "TOOL", attributes: { [attr.gateCommand]: label } },
    bounded.pipe(
      Effect.tap((ran) =>
        ran === undefined ? Effect.void : Effect.annotateCurrentSpan(attr.gateExit, ran.exitCode)
      )
    )
  )
  const failed = result === undefined || result.exitCode !== 0
  yield* events.publish(
    Timed.make({
      kind: "gate",
      label,
      ms: (yield* Clock.currentTimeMillis) - started,
      ...(result === undefined ? {} : { exitCode: result.exitCode }),
      ...(failed ? { failed: true } : {})
    })
  )
  const output = result === undefined ? "" : [...result.stdout, ...result.stderr].join("\n").trim()
  let logPath: string | undefined
  if (options.log !== undefined) {
    yield* options.log.files.writeAtomic(options.log.path, output)
    logPath = options.log.path
  }
  if (result !== undefined && result.exitCode === 0) {
    return ReviewResult.make({ issues: [], summary: "lint passed" })
  }
  const seconds =
    options.timeout === undefined ? 0 : Math.round(Duration.toSeconds(options.timeout))
  return ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: `lint failed: ${label}`,
        description:
          result === undefined
            ? `gate killed: no exit after ${seconds} seconds (LLM4TS_GATE_TIMEOUT)`
            : processProblem(result.stdout, result.stderr, result.exitCode),
        gateClass: result === undefined ? "hang" : gateClassOf(result.exitCode),
        ...(logPath === undefined ? {} : { logPath })
      })
    ],
    summary: "lint failed"
  })
})
```

Import `ProcessResult` as a type from `@llm4ts/core/ProcessExecutor`. Keep `processProblem` as it is. The `PersistenceError` from `writeAtomic` is already a `FlowError` member (check `FlowError.ts`; if it is not in the union, map it with `Effect.mapError` into `ProcessError.make({ message: label, detail: error.message })`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Review.test.ts`
Expected: PASS, including the two existing `lintCommand timing`/`spans` tests (the span still carries command and exit code).

- [ ] **Step 5: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add packages/flow/src/Review.ts packages/flow/test/Review.test.ts
git commit -m "flow: a gate has a timeout, a class (red, hang, crash) and an optional log file

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Triage in the review loop and the fix prompt's evidence

**Files:**

- Modify: `packages/flow/src/Review.ts` (`fixPrompt`, `ReviewAndFixOptions`, `reviewOnce`)
- Modify: `packages/flow/src/Flow.ts` (the final gate check after `reviewAndFixLoop`, lines ~293–305)
- Test: `packages/flow/test/Review.test.ts`, `packages/flow/test/Flow.test.ts`

**Interfaces:**

- Consumes: `triageGates`, `GateBaseline`, `GateTriage` (Task 1); `logPath` (Task 2).
- Produces (used by Tasks 5–6):

```ts
export interface GateTriageOptions {
  /** The baseline for the code this change started from; `undefined` means no triage. */
  readonly baseline: Effect.Effect<GateBaseline | undefined, FlowError>
  /** Root prefixes to strip from output (the work dir, the app dir). */
  readonly roots: ReadonlyArray<string>
  /** Re-run the test gate alone to tell a flaky line from a new one; omit to never rerun. */
  readonly rerunTest?: Effect.Effect<ReviewResult, FlowError>
}
export interface FixPromptOptions {
  readonly tailChars?: number // default 4000
  readonly showPaths?: boolean // CLI coders: true; API coders: false
}
export const fixPrompt: (result: ReviewResult, options?: FixPromptOptions) => string
// ReviewAndFixOptions gains:
//   readonly triage?: GateTriageOptions
//   readonly fix?: FixPromptOptions
export const applyTriage: (
  lint: ReviewResult,
  triage: GateTriageOptions | undefined,
  events: FlowEventsShape,
  reported: Ref.Ref<ReadonlySet<string>> // inherited lines already published as Info
) => Effect.Effect<ReviewResult, FlowError>
```

- [ ] **Step 1: Write the failing tests**

In `Review.test.ts`, add `import { GateBaseline } from "@llm4ts/flow/Gates"` and `import { fixPrompt, applyTriage } from "@llm4ts/flow/Review"` (extend the existing import). Add:

```ts
describe("fixPrompt evidence", () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n")
  const gate = ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: "lint failed: pnpm test",
        description: long,
        logPath: "/state/stories/a/gates/1-pnpm-test.log"
      })
    ],
    summary: "lint failed"
  })

  it("caps the output to the tail and points a CLI coder at the log as its only evidence", () => {
    const prompt = fixPrompt(gate, { tailChars: 100, showPaths: true })
    assert.include(prompt, "line 199")
    assert.notInclude(prompt, "line 0\n")
    assert.include(prompt, "/state/stories/a/gates/1-pnpm-test.log")
    assert.include(prompt, "only runtime evidence")
    assert.include(prompt, "confidence: low")
  })

  it("an API coder gets the tail and no path", () => {
    const prompt = fixPrompt(gate, { tailChars: 100, showPaths: false })
    assert.notInclude(prompt, "/state/stories")
    assert.include(prompt, "only runtime evidence")
  })

  it("a review finding without a log renders exactly as before", () => {
    const finding = ReviewResult.make({
      issues: [ReviewIssue.make({ severity: "Warning", title: "naming", description: "rename x" })],
      summary: ""
    })
    assert.strictEqual(
      fixPrompt(finding),
      "Address these review findings, then stop:\n- [Warning] naming: rename x"
    )
  })
})

describe("applyTriage", () => {
  const roots = ["/wt/a"]
  const lint = (output: string) =>
    ReviewResult.make({
      issues: [
        ReviewIssue.make({
          severity: "Critical",
          title: "lint failed: pnpm test",
          description: output
        })
      ],
      summary: "lint failed"
    })
  const baseline = GateBaseline.make({
    baseCommit: "abc",
    appDir: ".",
    commands: ["pnpm test"],
    failingLines: ["FAIL old.test.ts > old"],
    recordedAt: 0
  })

  it.effect("inherited failures are published once as Info and do not block", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
      const triage = { baseline: Effect.succeed(baseline), roots }
      const first = yield* applyTriage(lint("FAIL old.test.ts > old"), triage, events, reported)
      const second = yield* applyTriage(lint("FAIL old.test.ts > old"), triage, events, reported)
      assert.isTrue(first.isClean)
      assert.isTrue(second.isClean)
      const infos = (yield* events.recorded).filter((event) => event._tag === "Info")
      assert.strictEqual(infos.length, 1)
      assert.include(infos[0]?._tag === "Info" ? infos[0].message : "", "inherited from the base")
    })
  )

  it.effect(
    "a new failure blocks with origin new; a line green on the rerun is flaky and does not",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents()
        const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
        const blocked = yield* applyTriage(
          lint("FAIL old.test.ts > old\nFAIL new.test.ts > new"),
          { baseline: Effect.succeed(baseline), roots },
          events,
          reported
        )
        assert.strictEqual(blocked.issues[0]?.origin, "new")
        assert.include(blocked.issues[0]?.description ?? "", "new.test.ts")

        const flaky = yield* applyTriage(
          lint("FAIL old.test.ts > old\nFAIL flaky.test.ts > flaky"),
          {
            baseline: Effect.succeed(baseline),
            roots,
            rerunTest: Effect.succeed(lint("FAIL old.test.ts > old"))
          },
          events,
          reported
        )
        assert.isTrue(flaky.isClean)
        const infos = (yield* events.recorded).filter((event) => event._tag === "Info")
        assert.isTrue(
          infos.some((event) => event._tag === "Info" && event.message.includes("flaky"))
        )
      })
  )

  it.effect("without triage options the result is returned untouched", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents()
      const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
      const result = lint("FAIL old.test.ts > old")
      assert.strictEqual(yield* applyTriage(result, undefined, events, reported), result)
    })
  )
})
```

In `Flow.test.ts`, find the existing test that uses `lint` with `implementPlanFlow` (search `lint:`) and add one beside it, reusing its harness helpers:

```ts
it.effect(
  "a lint gate red only with inherited failures does not stop the commit when triage is given",
  () =>
    Effect.gen(function* () {
      // Build the harness exactly as the neighbouring lint test does, then:
      const baseline = GateBaseline.make({
        baseCommit: "base",
        appDir: ".",
        commands: ["pnpm test"],
        failingLines: ["FAIL old.test.ts > old"],
        recordedAt: 0
      })
      const red = ReviewResult.make({
        issues: [
          ReviewIssue.make({
            severity: "Critical",
            title: "lint failed: pnpm test",
            description: "FAIL old.test.ts > old"
          })
        ],
        summary: "lint failed"
      })
      // ...implementPlanFlow(context, { ...sameOptions, lint: Effect.succeed(red),
      //    triage: { baseline: Effect.succeed(baseline), roots: [] } })
      // assert: the task is committed (plan shows [x]) and no FlowAborted is raised;
      // then the same call WITHOUT `triage` fails with FlowAborted mentioning "still failing".
    })
)
```

Write the assertions in the harness's own style (the neighbouring test shows how the plan file and the commit are observed).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Review.test.ts test/Flow.test.ts`
Expected: FAIL — `applyTriage` not exported; `fixPrompt` ignores options; `implementPlanFlow` has no `triage`.

- [ ] **Step 3: Implement `fixPrompt` options and `applyTriage`**

In `Review.ts`:

```ts
import * as Ref from "effect/Ref"
import { triageGates, type GateBaseline } from "./Gates.ts"

export interface FixPromptOptions {
  readonly tailChars?: number
  readonly showPaths?: boolean
}

const defaultTailChars = 4_000

const evidenceNote =
  "The gate output above is your only runtime evidence. If you are guessing without it, say `confidence: low` in your Findings."

export const fixPrompt = (result: ReviewResult, options: FixPromptOptions = {}): string => {
  const tailChars = options.tailChars ?? defaultTailChars
  const lines = result.issues.map((issue) => {
    const description =
      issue.description.length > tailChars
        ? `…${issue.description.slice(-tailChars)}`
        : issue.description
    const path =
      options.showPaths === true && issue.logPath !== undefined
        ? ` (full output: ${issue.logPath})`
        : ""
    return `- [${issue.severity}] ${issue.title}: ${description}${path}`
  })
  const hasGate = result.issues.some((issue) => issue.title.startsWith("lint failed: "))
  return [
    "Address these review findings, then stop:",
    ...lines,
    ...(hasGate ? ["", evidenceNote] : [])
  ].join("\n")
}

export interface GateTriageOptions {
  readonly baseline: Effect.Effect<GateBaseline | undefined, FlowError>
  readonly roots: ReadonlyArray<string>
  readonly rerunTest?: Effect.Effect<ReviewResult, FlowError>
}

/**
 * Charges a lint result only with what the change caused. Inherited lines
 * are published once per loop as Info; with `rerunTest`, a new line that is
 * green on one rerun of the test gate is flaky: published, not charged.
 */
export const applyTriage = Effect.fn("@llm4ts/flow/Review.applyTriage")(function* (
  lint: ReviewResult,
  triage: GateTriageOptions | undefined,
  events: FlowEventsShape,
  reported: Ref.Ref<ReadonlySet<string>>
): Effect.fn.Return<ReviewResult, FlowError> {
  if (triage === undefined || lint.isClean) {
    return lint
  }
  const baseline = yield* triage.baseline
  if (baseline === undefined) {
    return lint
  }
  let triaged = triageGates(lint, baseline, triage.roots)
  const unseen = triaged.inherited.filter((line) => !(yield * Ref.get(reported)).has(line))
  if (unseen.length > 0) {
    yield* Ref.update(reported, (set) => new Set([...set, ...unseen]))
    yield* events.publish(
      Info.make({
        message: `${unseen.length} gate failure(s) inherited from the base, not charged to this change:\n${unseen.map((line) => `  ${line}`).join("\n")}`
      })
    )
  }
  if (!triaged.blocking.isClean && triage.rerunTest !== undefined) {
    const again = yield* triage.rerunTest
    const second = triageGates(again, baseline, triage.roots)
    const stillRed = new Set(second.newLines)
    const flaky = triaged.newLines.filter((line) => !stillRed.has(line))
    if (flaky.length > 0) {
      yield* events.publish(
        Info.make({
          message: `${flaky.length} gate failure(s) flaky (red once, green on rerun), not charged:\n${flaky.map((line) => `  ${line}`).join("\n")}`
        })
      )
      triaged = triageGates(
        again,
        GateBaseline.make({ ...baseline, failingLines: [...baseline.failingLines, ...flaky] }),
        triage.roots
      )
    }
  }
  return triaged.blocking
})
```

Note the `yield*` inside `.filter` is not allowed: read the set once before filtering (`const seen = yield* Ref.get(reported)`), then filter with `seen.has`.

In `ReviewAndFixOptions` add `readonly triage?: GateTriageOptions` and `readonly fix?: FixPromptOptions`. In `reviewAndFixLoop`, before `reviewOnce` is defined: `const reported = yield* Ref.make<ReadonlySet<string>>(new Set())`. In `reviewOnce` replace the lint check:

```ts
const lintRaw = yield * options.lint ?? Effect.succeed(ReviewResult.make({ issues: [] }))
const lint = yield * applyTriage(lintRaw, options.triage, options.events, reported)
if (!lint.isClean) {
  return lint
}
```

and in `loop`, the fix call becomes `yield* options.coder.ask(fixPrompt(result, options.fix))`.

- [ ] **Step 4: Apply the same triage to `implementPlanFlow`'s final gate check**

In `Flow.ts`, `ImplementPlanOptions` gains `readonly triage?: GateTriageOptions` and `readonly fix?: FixPromptOptions` (import the types from `./Review.ts`); pass both into `reviewAndFixLoop` the way `lint` is passed. Replace the final check:

```ts
if (options.lint !== undefined) {
  const reported = yield * Ref.make<ReadonlySet<string>>(new Set())
  const gate = yield * applyTriage(yield * options.lint, options.triage, context.events, reported)
  if (!gate.isClean) {
    return (
      yield *
      FlowAborted.make({
        /* unchanged message built from gate.issues */
      })
    )
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Review.test.ts test/Flow.test.ts test/Stories.test.ts`
Expected: PASS; every existing `reviewAndFixLoop` test passes unchanged (no `triage` given).

- [ ] **Step 6: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add packages/flow/src/Review.ts packages/flow/src/Flow.ts packages/flow/test/Review.test.ts packages/flow/test/Flow.test.ts
git commit -m "flow: the review loop charges a change only with the gate failures it caused; the fix prompt points at the log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `gatesIn` moves to `Gates.ts`; the shell lib wires timeout, logs and `--land` cleanup

**Files:**

- Modify: `packages/flow/src/Gates.ts` (add `gatesIn`, `GateRunOptions`, `compactGateLog`)
- Modify: `packages/shell/flows/lib/epic-stories.js` (remove `gatesIn`, import it; read `LLM4TS_GATE_TIMEOUT`, `LLM4TS_GATE_TAIL_CHARS`; pass `gateOptions`; `--land` cleanup)
- Modify: `packages/flow/src/Gates.ts` also gains `compactGateArtifacts(workspace, stateDir)`, called by the lib's `--land` path beside `compactTranscripts`
- Test: `packages/flow/test/Gates.test.ts`

**Interfaces:**

- Consumes: `lintCommand` with options (Task 2), `mergeReviewResults` (`Review.ts`).
- Produces (used by Task 5):

```ts
export interface GateRunOptions {
  readonly timeout?: Duration.Duration
  /** Where this run's logs go; `undefined` writes none. One file per gate command. */
  readonly logDir?: { readonly files: PlainFileStoreShape; readonly dir: string }
}
/** Runs the gates in a directory, stopping at the first red one (later output would be noise). */
export const gatesIn: (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  commands: ReadonlyArray<ReadonlyArray<string>>,
  options?: GateRunOptions
) => (
  workDir: string,
  laneEvents?: FlowEventsShape,
  log?: GateRunOptions["logDir"]
) => Effect.Effect<ReviewResult, FlowError>
export const gateLogName: (index: number, command: ReadonlyArray<string>) => string // `${index}-${slug}.log`
export const compactGateLog: (text: string, roots: ReadonlyArray<string>) => string // failing lines joined by "\n"
```

- [ ] **Step 1: Write the failing tests**

Append to `Gates.test.ts`:

```ts
describe("gatesIn", () => {
  const events = () => makeCollectingFlowEvents()
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
      const ev = yield* events()
      const memory = yield* makeMemoryPlainFileStore()
      const run = gatesIn(exits({ "pnpm lint": 1 }), ev, [
        ["pnpm", "typecheck"],
        ["pnpm", "lint"],
        ["pnpm", "test"]
      ])
      const result = yield* run("/wt/a", undefined, {
        files: memory.store,
        dir: "/state/stories/a/gates"
      })
      assert.strictEqual(result.issues.length, 1)
      assert.strictEqual(result.issues[0]?.title, "lint failed: pnpm lint")
      const files = Object.keys(yield* memory.files).sort()
      assert.deepStrictEqual(files, [
        "/state/stories/a/gates/0-pnpm-typecheck.log",
        "/state/stories/a/gates/1-pnpm-lint.log"
      ])
      assert.strictEqual(result.issues[0]?.logPath, "/state/stories/a/gates/1-pnpm-lint.log")
    })
  )

  it("compactGateLog keeps the failing lines only", () => {
    assert.strictEqual(
      compactGateLog(
        "\u001b[31m FAIL \u001b[39m a.test.ts > a\n    at x\n Duration 1s\nAssertionError: no",
        []
      ),
      "FAIL a.test.ts > a\nAssertionError: no"
    )
  })
})
```

Add the needed imports to `Gates.test.ts` (`makeCollectingFlowEvents` from `@llm4ts/flow/FlowEvents`, `ProcessResult`, `makeProcessExecutor` from `@llm4ts/core/ProcessExecutor`, `Stream` from `effect/Stream`, `gatesIn`, `compactGateLog` from `@llm4ts/flow/Gates`).

Also in `Gates.test.ts` (imports: `makeMemoryWorkspace` from `@llm4ts/flow/Workspace`, `compactGateArtifacts` from `@llm4ts/flow/Gates`):

```ts
describe("compactGateArtifacts", () => {
  it.effect("deletes gate baselines and compacts gate logs to their failing lines", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        ".llm4ts/epics/e/gates/baseline-abc.json": "{}",
        ".llm4ts/epics/e/stories/a/gates/0-pnpm-test.log":
          "\u001b[31m FAIL \u001b[39m a.test.ts > a\n    at x\nAssertionError: no",
        ".llm4ts/epics/e/stories/a.findings.md": "untouched"
      })
      const counts = yield* compactGateArtifacts(workspace.workspace, ".llm4ts/epics/e")
      assert.deepStrictEqual(counts, { baselines: 1, logs: 1 })
      const files = yield* workspace.files
      assert.isUndefined(files[".llm4ts/epics/e/gates/baseline-abc.json"])
      assert.strictEqual(
        files[".llm4ts/epics/e/stories/a/gates/0-pnpm-test.log"],
        "FAIL a.test.ts > a\nAssertionError: no"
      )
      assert.strictEqual(files[".llm4ts/epics/e/stories/a.findings.md"], "untouched")
    })
  )
})
```

Check `makeMemoryWorkspace`'s real constructor and accessor names in `packages/flow/src/Workspace.ts` (it takes an initial file map and exposes the `WorkspaceShape`; adapt the two property names) before running.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Gates.test.ts`
Expected: FAIL — `gatesIn`, `compactGateLog`, `compactGateArtifacts` not exported.

- [ ] **Step 3: Implement `gatesIn`, `gateLogName`, `compactGateLog` in `Gates.ts`**

```ts
import type * as Duration from "effect/Duration"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { lintCommand, mergeReviewResults } from "./Review.ts"

export interface GateRunOptions {
  readonly timeout?: Duration.Duration
  readonly logDir?: { readonly files: PlainFileStoreShape; readonly dir: string }
}

export const gateLogName = (index: number, command: ReadonlyArray<string>): string =>
  `${index}-${command
    .join(" ")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase()}.log`

/** Runs the gates in a directory, stopping at the first red one (later output would be noise). */
export const gatesIn =
  (
    process: ProcessExecutorShape,
    events: FlowEventsShape,
    commands: ReadonlyArray<ReadonlyArray<string>>,
    options: GateRunOptions = {}
  ) =>
  (
    workDir: string,
    laneEvents?: FlowEventsShape,
    log?: GateRunOptions["logDir"]
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const sink = log ?? options.logDir
      const results: Array<ReviewResult> = []
      for (const [index, command] of commands.entries()) {
        const result = yield* lintCommand(process, laneEvents ?? events, command, workDir, {
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(sink === undefined
            ? {}
            : { log: { files: sink.files, path: join(sink.dir, gateLogName(index, command)) } })
        })
        results.push(result)
        if (!result.isClean) break
      }
      return mergeReviewResults(results)
    })

/** A landed epic keeps why a gate was red, not the target's whole test output. */
export const compactGateLog = (text: string, roots: ReadonlyArray<string>): string =>
  normalizeGateOutput(text, roots).join("\n")
```

`Gates.ts` now imports `lintCommand` from `Review.ts` and `Review.ts` imports `triageGates` from `Gates.ts`: a cycle. Resolve it by moving `triageGates`, `normalizeGateOutput`, `failingLinesOf`, `GateBaseline`, the store helpers and `GateTriage` into `packages/flow/src/GateTriage.ts` (exported as `"./GateTriage"`), and keeping `gatesIn`, `gateLogName`, `compactGateLog`, `GateRunOptions` in `Gates.ts`, which re-exports everything from `GateTriage.ts`. `Review.ts` imports from `./GateTriage.ts` only. Update Task 1's test import to `@llm4ts/flow/Gates` (the re-export keeps it valid).

- [ ] **Step 4: Replace the lib's `gatesIn` and wire the knobs**

In `packages/shell/flows/lib/epic-stories.js`:

- delete the local `gatesIn` (lines ~1041–1052) and add `import { gatesIn, compactGateLog } from "@llm4ts/flow/Gates";`
- add two readers beside `storiesEnvironment`:

```js
/** `LLM4TS_GATE_TIMEOUT` in seconds (default 1200); empty or invalid means the default. */
export const gateTimeoutSeconds = (environment) => {
  const raw = Number.parseInt(environment.LLM4TS_GATE_TIMEOUT ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 1200
}
/** `LLM4TS_GATE_TAIL_CHARS` (default 4000); empty or invalid means the default. */
export const gateTailChars = (environment) => {
  const raw = Number.parseInt(environment.LLM4TS_GATE_TAIL_CHARS ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 4000
}
```

- at both call sites (`--land` and the main run) build `const gateOptions = { timeout: Duration.seconds(gateTimeoutSeconds(process.env)) }` and call `gatesIn(nodeProcessExecutor, events, commands, gateOptions)`; pass `tailChars: gateTailChars(process.env)` and `showPaths` (true when the coder seat is a CLI connector — the lib already knows the coder's connector kind where it builds the roster; if not, default `true` and note it) into `implementStoriesFlow` as `fix` (Task 5 adds the option).
- `--land`: right after the existing `compactTranscripts(input.workDir, earlier)` call, add `const gateArtifacts = yield* compactGateArtifacts(workspace, stateDir)` (the lib already has the node workspace and `stateDir` in scope) and print its counts beside the compacted-transcripts line.

- [ ] **Step 5: `landEpic` cleans baselines and compacts logs**

In `Gates.ts`:

```ts
import { matchingFiles } from "./SpecChecks.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

/**
 * What `--land` keeps of the gates: no baselines (reproducible), and each
 * gate log reduced to its failing lines, so a landed epic still says why a
 * story was red without storing the target's test output.
 */
export const compactGateArtifacts = Effect.fn("@llm4ts/flow/Gates.compactArtifacts")(function* (
  workspace: WorkspaceShape,
  stateDir: string
): Effect.fn.Return<{ readonly baselines: number; readonly logs: number }, WorkspaceError> {
  const escaped = stateDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const baselines = yield* matchingFiles(workspace, `^${escaped}/gates/baseline-[^/]+\\.json$`)
  for (const path of baselines) {
    yield* workspace.remove(path)
  }
  const logs = yield* matchingFiles(workspace, `^${escaped}/stories/[^/]+/gates/[^/]+\\.log$`)
  for (const path of logs) {
    const text = yield* workspace.read(path)
    yield* workspace.writeAtomic(path, compactGateLog(text, []))
  }
  return { baselines: baselines.length, logs: logs.length }
})
```

Use the `WorkspaceShape` method names as `Workspace.ts` spells them (`read`, `writeAtomic`/`write`, `remove`/`delete`); `matchingFiles` already returns repo-relative paths.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Gates.test.ts test/Stories.test.ts && pnpm --filter @llm4ts/shell test`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add packages/flow/src/Gates.ts packages/flow/src/GateTriage.ts packages/flow/src/Review.ts packages/flow/package.json packages/shell/flows/lib/epic-stories.js packages/flow/test/Gates.test.ts
git commit -m "flow: gatesIn lives in Gates with a timeout and per-gate logs; --land deletes baselines and compacts logs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Stories — a baseline per epic head, triage per story, inherited reds reported

**Files:**

- Modify: `packages/flow/src/Stories.ts` (`StoriesOptions`, run start, per-story gates, `commitGreen`, post-merge gate, findings, report)
- Modify: `packages/shell/flows/lib/epic-stories.js` (pass `appDir`, `gateCommands`, `fix`)
- Test: `packages/flow/test/Stories.test.ts`

**Interfaces:**

- Consumes: `baselineKey`, `baselinePath`, `readBaseline`, `writeBaseline`, `failingLinesOf`, `GateBaseline`, `triageGates` (Task 1/4), `GateTriageOptions`, `FixPromptOptions`, `applyTriage` (Task 3), `gatesIn` signature with `log` (Task 4).
- Produces: `StoriesOptions` gains

```ts
/** The gate commands as configured and the app dir, so a baseline is keyed and logs are named. */
readonly gateCommands?: ReadonlyArray<ReadonlyArray<string>>
readonly appDir?: string                       // default "."
/** The test gate alone, for the flaky rerun; omit to never rerun. */
readonly testGate?: (workDir: string, events?: FlowEventsShape) => Effect.Effect<ReviewResult, FlowError>
readonly fix?: FixPromptOptions
```

and `StoryOutcome` gains `inherited: Schema.optionalKey(Schema.Array(Schema.String))`; `EpicReport` renders an "Inherited gate failures" section when any story has them.

- [ ] **Step 1: Write the failing tests**

In `Stories.test.ts`, extend the harness so `gates` can return different results per directory and per call count, then add:

```ts
describe("gate baselines (ADR 0027)", () => {
  it.effect(
    "a red base lets a story that did not touch it merge, lists the red once, and records a baseline for the new head",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ stories: [storyA] })
        // the epic checkout's gates are red with one inherited line, every time:
        yield* Ref.set(
          harness.gateOutput,
          new Map([
            ["/repo", "FAIL old.test.ts > old"],
            ["/repo/.llm4ts/worktrees/a", "FAIL old.test.ts > old"]
          ])
        )
        const report = yield* runStories(harness, { gateCommands: [["pnpm", "test"]], appDir: "." })
        assert.strictEqual(report.stories[0]?.status, "done")
        assert.deepStrictEqual(report.stories[0]?.inherited, ["FAIL old.test.ts > old"])
        const files = yield* harness.files
        const baselines = Object.keys(files).filter((path) => path.includes("/gates/baseline-"))
        // one for the epic head at run start, one for the head after story a merged
        assert.strictEqual(baselines.length, 2)
        const infos = (yield* harness.events.recorded).filter(
          (event) => event._tag === "Info" && event.message.includes("inherited from the base")
        )
        assert.strictEqual(infos.length, 1)
      })
  )

  it.effect("a story that breaks a second test is blocked on that test only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ stories: [storyA] })
      yield* Ref.set(
        harness.gateOutput,
        new Map([
          ["/repo", "FAIL old.test.ts > old"],
          ["/repo/.llm4ts/worktrees/a", "FAIL old.test.ts > old\nFAIL new.test.ts > new"]
        ])
      )
      const report = yield* runStories(harness, { gateCommands: [["pnpm", "test"]], maxRounds: 1 })
      assert.strictEqual(report.stories[0]?.status, "failed")
      assert.include(report.stories[0]?.reason ?? "", "new.test.ts")
      assert.notInclude(report.stories[0]?.reason ?? "", "old.test.ts")
      const fixPrompts = yield* harness.coderPrompts
      assert.isTrue(
        fixPrompts.some(
          (prompt) => prompt.includes("new.test.ts") && !prompt.includes("old.test.ts")
        )
      )
    })
  )

  it.effect("the post-merge epic gate undoes the merge only for new failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ stories: [storyA] })
      yield* Ref.set(harness.gateOutput, new Map([["/repo", "FAIL old.test.ts > old"]]))
      const report = yield* runStories(harness, { gateCommands: [["pnpm", "test"]] })
      assert.strictEqual(report.stories[0]?.status, "done")
      assert.notInclude(report.stories[0]?.reason ?? "", "merge undone")
    })
  )

  it.effect(
    "without gateCommands nothing changes: a red base fails the first story as before",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ stories: [storyA] })
        yield* Ref.update(harness.redGates, (set) => new Set([...set, "/repo/.llm4ts/worktrees/a"]))
        const report = yield* runStories(harness, {})
        assert.strictEqual(report.stories[0]?.status, "failed")
      })
  )
})
```

Adapt `makeHarness`/`runStories` to the file's real helper names (the file has `harness.redGates`; add `harness.gateOutput: Ref<Map<string, string>>` whose entries turn into a red `lint failed: pnpm test` result with that output, and `harness.coderPrompts` collecting every `coder.ask` text if it does not exist yet). Keep every existing test green.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Stories.test.ts -t "gate baselines"`
Expected: FAIL — `gateCommands` unknown; inherited reds fail the story.

- [ ] **Step 3: Implement in `Stories.ts`**

Add to `StoriesOptions` the four fields from Interfaces. Inside `implementStoriesFlow`:

```ts
const appDir = options.appDir ?? "."
const gateCommands = options.gateCommands
const rootsOf = (workDir: string): ReadonlyArray<string> => [join(workDir, appDir), workDir]
const baselineFor = (commit: string): string =>
  baselinePath(
    options.stateDir,
    baselineKey({ baseCommit: commit, appDir, commands: gateCommands ?? [] })
  )
const gateLogDir = (story: Story): string => join(options.stateDir, `stories/${story.id}/gates`)

/** The baseline for `commit`, recording one from `run` when none is stored. */
const ensureBaseline = (
  commit: string,
  run: Effect.Effect<ReviewResult, FlowError>,
  workDir: string
): Effect.Effect<GateBaseline | undefined, FlowError> =>
  gateCommands === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const path = baselineFor(commit)
        const stored = yield* readBaseline(files, path)
        if (stored !== undefined) return stored
        const result = yield* run
        const baseline = GateBaseline.make({
          baseCommit: commit,
          appDir,
          commands: gateCommands.map((command) => command.join(" ")),
          failingLines: failingLinesOf(result, rootsOf(workDir)),
          recordedAt: yield* Clock.currentTimeMillis
        })
        yield* writeBaseline(files, path, baseline)
        return baseline
      })
```

Run start (after `stage(events, "epic branch", ...)`):

```ts
const epicHead = yield * context.git.checkpoint
yield * ensureBaseline(epicHead, options.gates(context.workDir, events), context.workDir)
```

Per story, after the worktree exists and before `implementPlanFlow`:

```ts
const storyBase = yield * git.checkpoint // the worktree's HEAD = the epic head it started from
const storyBaseline = ensureBaseline(
  storyBase,
  options.gates(state.worktree, laneOf(story)),
  state.worktree
)
const triage: GateTriageOptions = {
  baseline: storyBaseline,
  roots: rootsOf(state.worktree),
  ...(options.testGate === undefined
    ? {}
    : { rerunTest: options.testGate(state.worktree, laneOf(story)) })
}
```

Pass `triage` and `fix: options.fix` into `implementPlanFlow` beside `lint: gates`, and make `gates` write logs: `options.gates(state.worktree, laneOf(story), { files, dir: gateLogDir(story) })` — `StoriesOptions.gates` gains the third optional parameter (`log?: { files, dir }`); the test harness ignores it.

`commitGreen`: replace `const regated = yield* gates` with

```ts
const reported = yield * Ref.make<ReadonlySet<string>>(new Set())
const regated = yield * applyTriage(yield * gates, triage, laneOf(story), reported)
```

Post-merge epic gate (inside `mergeLock.withPermit`):

```ts
const mergedHead = yield * context.git.checkpoint
const before =
  yield *
  ensureBaseline(checkpoint, Effect.succeed(ReviewResult.make({ issues: [] })), context.workDir)
// `checkpoint` is the epic head before the merge; its baseline exists (run start or a previous merge).
const gate = yield * options.gates(context.workDir, lane)
const verdict = triageGates(gate, before, rootsOf(context.workDir))
if (!verdict.blocking.isClean) {
  yield * context.git.rollback(checkpoint)
  return (
    yield *
    failed(story, `epic gates failed after merging; merge undone:\n${issueLines(verdict.blocking)}`)
  )
}
yield *
  writeBaseline(
    files,
    baselineFor(mergedHead),
    GateBaseline.make({
      baseCommit: mergedHead,
      appDir,
      commands: (gateCommands ?? []).map((command) => command.join(" ")),
      failingLines: failingLinesOf(gate, rootsOf(context.workDir)),
      recordedAt: yield * Clock.currentTimeMillis
    })
  )
```

Guard the two `writeBaseline`/`ensureBaseline` calls with `gateCommands !== undefined` so a caller without commands keeps today's exact behaviour (`gate.isClean` decides).

Inherited lines for the report: collect what `applyTriage` published for the story. Simplest: `Stories.ts` wraps `laneOf(story)` events already (`appendFindings` reads review rounds); add an `inheritedRef: Ref<ReadonlyArray<string>>` per story filled where `ensureBaseline`'s baseline has `failingLines` (those are the inherited set for that story), and set `StoryOutcome.inherited` from it when non-empty. Also `appendFindings(story, "inherited gate failures (not charged)", ReviewResult.make({ issues: lines.map(line => ReviewIssue.make({ severity: "Info", title: line, origin: "base" })) }))` once per story.

`renderEpicReport`: after the stories table, when any story has `inherited`, add:

```
## Inherited gate failures

Red on the base before any story ran; not charged to a story. A cleanup story may own them.

- FAIL old.test.ts > old  (stories: a, b)
```

- [ ] **Step 4: Wire the lib**

In `epic-stories.js` main run, pass to `implementStoriesFlow`: `gateCommands: commands`, `appDir`, `testGate: inAppDir(appDir, gatesIn(nodeProcessExecutor, events, commands.filter((command) => command[1] === "test"), gateOptions))` when such a command exists, and `fix: { tailChars: gateTailChars(process.env), showPaths: true }` (set `showPaths` from the coder's connector kind when the lib has it in scope; the API-coder case is covered by Task 3's unit test).

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Stories.test.ts && pnpm --filter @llm4ts/shell test`
Expected: PASS, every pre-existing Stories test unchanged.

- [ ] **Step 6: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add packages/flow/src/Stories.ts packages/shell/flows/lib/epic-stories.js packages/flow/test/Stories.test.ts
git commit -m "epic-stories: a baseline per epic head; a story is charged only with the gate failures it caused; inherited reds reported once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `implementPlanFlow` baselines for the flat-plan flows

**Files:**

- Modify: `packages/flow/src/Flow.ts` (`ImplementPlanOptions.baseline`, per-task baseline from the checkpoint)
- Modify: `packages/shell/flows/implement.js`, `packages/shell/flows/sdd.js`, `packages/shell/flows/issue-pr.js` (pass `baseline` and `fix`)
- Test: `packages/flow/test/Flow.test.ts`

**Interfaces:**

- Consumes: `applyTriage`, `GateTriageOptions` (Task 3); `ensureBaseline` logic (re-implemented here as a small helper in `GateTriage.ts`, see Step 3).
- Produces: `ImplementPlanOptions` gains

```ts
/** Record and read gate baselines under this store; the base is the task's checkpoint commit. */
readonly baseline?: {
  readonly files: PlainFileStoreShape
  readonly dir: string
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
  readonly appDir?: string
}
```

and `GateTriage.ts` exports

```ts
export const ensureBaseline: (args: {
  files: PlainFileStoreShape
  dir: string
  commit: string
  appDir: string
  commands: ReadonlyArray<ReadonlyArray<string>>
  run: Effect.Effect<ReviewResult, FlowError>
  roots: ReadonlyArray<string>
}) => Effect.Effect<GateBaseline, FlowError>
```

(Task 5's `Stories.ts` switches to this helper in the same commit, so the logic lives once.)

- [ ] **Step 1: Write the failing test**

In `Flow.test.ts`, beside Task 3's triage test:

```ts
it.effect(
  "with `baseline`, the first task records the gates on its checkpoint and later tasks are charged only with new failures",
  () =>
    Effect.gen(function* () {
      // harness as the neighbouring lint test; a `lint` whose output is
      // "FAIL old.test.ts > old" on every call; two tasks in the plan.
      // implementPlanFlow(context, { ...options, lint, baseline: { files: memory.store, dir: "/state", commands: [["pnpm","test"]] } })
      // assert: both tasks are committed; exactly one "/state/gates/baseline-*.json" exists;
      //         one Info "inherited from the base" was published.
    })
)
```

Write it fully in the harness's style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Flow.test.ts -t "baseline"`
Expected: FAIL — unknown option `baseline`.

- [ ] **Step 3: Implement**

In `GateTriage.ts` add `ensureBaseline` (the body from Task 5 Step 3, parameterised); refactor `Stories.ts` to call it. In `Flow.ts`, at the top of each task's iteration where the checkpoint is taken (`context.git.checkpoint`), when `options.baseline !== undefined && options.lint !== undefined`:

```ts
const base = options.baseline
const triage: GateTriageOptions = {
  baseline: ensureBaseline({
    files: base.files,
    dir: base.dir,
    commit: checkpoint,
    appDir: base.appDir ?? ".",
    commands: base.commands,
    run: options.lint,
    roots: [join(context.workDir, base.appDir ?? "."), context.workDir]
  }),
  roots: [join(context.workDir, base.appDir ?? "."), context.workDir]
}
```

and pass `triage` into `reviewAndFixLoop` and into the final `applyTriage` (Task 3) in place of `options.triage` when `options.triage` is undefined. `ensureBaseline` is lazy: it runs the gates only when no baseline exists for that commit, so a second task on an unchanged checkpoint costs nothing extra.

In the three built-in flows, where `lint:` is passed, also pass `baseline: { files, dir: <the flow's .llm4ts state dir>, commands: <its gate commands> }` and `fix: { tailChars: gateTailChars(process.env), showPaths: true }`. Each flow already has `files`/a plan store directory; reuse those names.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Flow.test.ts test/Stories.test.ts && pnpm --filter @llm4ts/shell test`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add packages/flow/src/Flow.ts packages/flow/src/GateTriage.ts packages/flow/src/Stories.ts packages/shell/flows/implement.js packages/shell/flows/sdd.js packages/shell/flows/issue-pr.js packages/flow/test/Flow.test.ts
git commit -m "flow: implementPlanFlow records a gate baseline on each task's checkpoint and charges a task only with new failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Documentation, parity note, changelog

**Files:**

- Modify: `docs/configuration.md` (new section "Gates" with the two variables, placed before "Capabilities")
- Modify: `docs/flow-authoring.md` ("Per-task gates" section: timeout, class, log, triage, `baseline` option)
- Modify: `docs/parity.md` (divergence note under the ADR list)
- Modify: `CHANGELOG.md` (an "Unreleased" entry; the version bump to 2.31.0 happens when the release A specs are all in)
- Modify: `specs/pending/gate-baselines-and-triage.md` — **do not touch** (ADR 0004: checkbox state is not written by agents); report completion in the commit message instead.

- [ ] **Step 1: `docs/configuration.md`**

Add before `## Capabilities`:

```markdown
## Gates

The target's gate commands (typecheck, lint, test, build, or `LLM4TS_GATES`)
run after every task and after every merge (ADR 0013). Since ADR 0027 a gate
has a timeout, a class and a memory: the gates' result on the code a change
started from is recorded as a baseline under the run's state folder, and a
change is charged only with the failing lines it added. Lines already red on
the base are listed once as inherited; a test-gate line red once and green on
one rerun is flaky; neither blocks. Gate output is written to
`stories/<id>/gates/<n>-<command>.log` in the state folder and the fix prompt
carries its tail and, for CLI coders, its path.

| Variable                 | Effect                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `LLM4TS_GATE_TIMEOUT`    | Seconds before a gate is killed and reported as a hang. Default `1200` |
| `LLM4TS_GATE_TAIL_CHARS` | Characters of gate output in the fix prompt. Default `4000`            |

`--land` deletes the baselines and compacts the gate logs to their failing
lines.
```

- [ ] **Step 2: `docs/flow-authoring.md`**

In "Per-task gates", after the existing `lintCommand` example, add a paragraph and snippet:

````markdown
A gate can be bounded and remembered. `lintCommand` takes `{ timeout, log }`;
`implementPlanFlow` takes `baseline: { files, dir, commands }` and then
charges a task only with the failures its checkpoint did not already have:

```ts
yield *
  implementPlanFlow(context, {
    // ...
    lint: gatesIn(process, events, commands, { timeout: Duration.seconds(1200) })(workDir),
    baseline: { files, dir: ".llm4ts/implement", commands },
    fix: { tailChars: 4000, showPaths: true }
  })
```
````

Without `baseline` every red line blocks, as before.

````

- [ ] **Step 3: `docs/parity.md`**

Append under the divergence list:

```markdown
- Gate baselines and triage (ADR 0027, 2026-10-06): the pinned llm4zio charges
  a task with every red gate; llm4ts records a baseline per base commit and
  charges only new failing lines, lists inherited ones, reruns the test gate
  once to tell flaky from new, bounds a gate with `LLM4TS_GATE_TIMEOUT`, and
  writes gate output to the run's state folder.
````

- [ ] **Step 4: `CHANGELOG.md`**

Add at the top:

```markdown
## Unreleased

Gates with a memory (ADR 0027, release A of the rewrite-grade loops).

- **A story is charged only with the gate failures it caused.** The gates'
  result on the epic head is recorded as a baseline at run start and after
  every merge; failing lines already on the base are listed once as inherited
  and never block; a test-gate line red once and green on one rerun is flaky
  and reported. `implement`, `sdd` and `issue-pr` do the same per task against
  the task's checkpoint.
- **A gate has a timeout and a class.** `LLM4TS_GATE_TIMEOUT` (default 1200 s)
  kills a hung gate and reports it as `hang`; a signal exit is `crash`.
- **Gate output is a file.** `stories/<id>/gates/<n>-<command>.log` in the
  run's state folder; the fix prompt carries its tail
  (`LLM4TS_GATE_TAIL_CHARS`, default 4000) and, for CLI coders, its path, as
  the coder's only runtime evidence. `--land` compacts logs to failing lines
  and deletes baselines.
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm format && pnpm format:check && pnpm lint`

```bash
git add docs/configuration.md docs/flow-authoring.md docs/parity.md CHANGELOG.md
git commit -m "docs: gate baselines, triage, timeout and logs (ADR 0027); spec gate-baselines-and-triage complete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: module `Gates.ts` (Tasks 1, 4), `lintCommand` timeout/class (2), log files and fix prompt (2, 3), triage in the loop (3), Stories baselines/report/`--land` (4, 5), `implementPlanFlow` checkpoint base (6), docs/parity/changelog (7). The spec's "`ReviewIssue` gains `origin`" lands in Task 1 so Task 1's tests can assert it.
- Type consistency: `GateBaseline`, `triageGates`, `applyTriage`, `GateTriageOptions`, `FixPromptOptions`, `gatesIn(process, events, commands, options)(workDir, laneEvents, log)` are spelled identically in Tasks 1–6. Task 4 moves the pure helpers to `GateTriage.ts` with `Gates.ts` re-exporting them, so every `@llm4ts/flow/Gates` import in the tests stays valid.
- Review Focus 1–5 are pinned in Tasks 5, 3/5, 1, 3/6 and 2 respectively.
