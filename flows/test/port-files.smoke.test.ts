import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { QueueOutcome } from "@llm4ts/flow/WorkQueue"
import {
  commitAll,
  commonReplies,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  stubProgram,
  write
} from "./support/smoke.ts"

/**
 * The port flows with the coder stubbed (ADR 0028). Asked to port a file,
 * the stub writes the target with a PORT STATUS trailer; asked to fix a
 * unit's diagnostics, it writes the marker the diagnostics script checks.
 * The queue, the pilot approval, the ledger, the trailer parsing and the
 * one-rebuild-per-round loop are exercised for real.
 */
const responder = [
  "(prompt) => {",
  commonReplies,
  "  const port = /Write the ported file at: (\\S+)/.exec(prompt)",
  "  if (port) {",
  "    const target = port[1]",
  '    const low = target.endsWith("b.rs")',
  "    fs.mkdirSync(path.dirname(target), { recursive: true })",
  "    fs.writeFileSync(target, [",
  '      "fn ported() {}",',
  '      "",',
  '      "// PORT STATUS",',
  '      "// source: " + target.replace(/\\.rs$/, ".zig"),',
  '      "// confidence: " + (low ? "low" : "high"),',
  '      "// todos: " + (low ? "2" : "0"),',
  '      "// notes: " + (low ? "comptime loop unrolled by hand" : "none"),',
  '      ""',
  '    ].join("\\n"))',
  '    return "Drafted " + target',
  "  }",
  '  if (prompt.includes("diagnostic(s) from")) {',
  '    fs.writeFileSync("FIXED", "yes\\n")',
  '    return "Fixed the unit."',
  "  }",
  '  return "Acknowledged."',
  "}"
].join("\n")

const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(QueueOutcome))

const portPack = [
  "# Pack: smoke-port",
  "",
  "source: zig",
  "sources: .*\\.zig$",
  "target: {{dir}}/{{base}}.rs",
  "comment: //",
  "specs-dir: docs/port",
  "features-dir: docs/port/features",
  "",
  "## Diagnostics",
  "",
  "- command: node diagnostics.mjs",
  "- format: json"
].join("\n")

const seed = (root: string, repo: string): void => {
  write(root, "packs/smoke-port/pack.md", portPack)
  write(
    root,
    "packs/smoke-port/prompts/porting.md",
    "Translate faithfully. Same names, same order.\n"
  )
  write(
    root,
    "packs/smoke-port/patterns/pitfalls-zig-rust.md",
    "---\ntitle: pitfalls\nmatches: .\n---\nAssert side effects.\n"
  )
  initRepo(repo)
  write(repo, "src/a.zig", "pub fn a() void {}\n")
  write(repo, "src/b.zig", "pub fn b() void {}\n")
  write(
    repo,
    "diagnostics.mjs",
    [
      'import { existsSync } from "node:fs"',
      "if (!existsSync('FIXED')) {",
      '  console.log(JSON.stringify({ file: "src/a.rs", line: 1, message: "E0425: cannot find value", unit: "crate_a" }))',
      '  console.log(JSON.stringify({ file: "src/b.rs", line: 1, message: "E0308: mismatched types", unit: "crate_b" }))',
      "}",
      ""
    ].join("\n")
  )
  commitAll(repo, "seeded sources")
}

describe("port flows end to end (model stubbed)", { timeout: smokeTimeout * 2 }, () => {
  it("spreads the drafts over worktree shards, merges them back and removes the shards", () => {
    const fixture = makeFixture()
    const repo = join(fixture.root, "repo")
    try {
      seed(fixture.root, repo)
      installStub(fixture, stubProgram(responder))
      const run = runFlow(fixture, "port-files", repo, {
        LLM4TS_PACK: "packs/smoke-port",
        LLM4TS_PORT_CONCURRENCY: "2",
        LLM4TS_PORT_SHARDS: "2"
      })
      assert.strictEqual(run.status, 0, failureReport("sharded", run))
      assert.isTrue(existsSync(join(repo, "src/a.rs")))
      assert.isTrue(existsSync(join(repo, "src/b.rs")))
      assert.isFalse(existsSync(join(repo, ".llm4ts/port/shards/1")))
      const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })
      assert.notInclude(worktrees, "shards")
      const branches = execFileSync("git", ["branch", "--list", "llm4ts/port-shard-*"], {
        cwd: repo,
        encoding: "utf8"
      })
      assert.strictEqual(branches.trim(), "")
      const log = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" })
      assert.include(log, "port: merge shard-")
      assert.include(`${run.stdout}\n${run.stderr}`, "2 shard(s)")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("pilots one file behind an approval, then drafts the rest with a ledger and a report", () => {
    const fixture = makeFixture()
    const repo = join(fixture.root, "repo")
    try {
      seed(fixture.root, repo)
      installStub(fixture, stubProgram(responder))
      const env = { LLM4TS_PACK: "packs/smoke-port", LLM4TS_PORT_CONCURRENCY: "1" }

      const pilot = runFlow(fixture, "port-files", repo, { ...env, LLM4TS_PORT_PILOT: "1" })
      assert.strictEqual(pilot.status, 0, failureReport("pilot", pilot))
      assert.isTrue(existsSync(join(repo, "src/a.rs")))
      assert.isFalse(existsSync(join(repo, "src/b.rs")))
      const pilotReport = readFileSync(join(repo, ".llm4ts/port/pilot.md"), "utf8")
      assert.include(pilotReport, "piloted: 1 file(s), 1 done")
      assert.include(pilotReport, "remaining: 1 file(s)")
      assert.isTrue(pilotReport.trimEnd().endsWith("- [ ] Approved"))

      const refused = runFlow(fixture, "port-files", repo, env)
      assert.notStrictEqual(refused.status, 0, "the full run must wait for the pilot's approval")
      assert.include(`${refused.stdout}\n${refused.stderr}`, "Approved")

      write(repo, ".llm4ts/port/pilot.md", pilotReport.replace("- [ ] Approved", "- [x] Approved"))
      const full = runFlow(fixture, "port-files", repo, env)
      assert.strictEqual(full.status, 0, failureReport("full", full))
      assert.isTrue(existsSync(join(repo, "src/b.rs")))
      const ledger = readFileSync(join(repo, ".llm4ts/port/ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeOutcome(line))
      assert.deepStrictEqual(
        ledger.map((entry) => [entry.id, entry.status, entry.confidence, entry.todos]),
        [
          ["src/a.zig", "done", "high", 0],
          ["src/b.zig", "done", "low", 2]
        ]
      )
      const report = readFileSync(join(repo, ".llm4ts/port/report.md"), "utf8")
      assert.include(report, "confidence: 0 high, 0 medium, 1 low")
      assert.include(report, "## Re-read against the source first")
      assert.include(report, "src/b.zig — comptime loop unrolled by hand")
      const log = readFileSync(join(repo, ".git/logs/HEAD"), "utf8")
      assert.include(log, "port: 1 file(s) drafted")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("works diagnostics as a queue, one unit per fixer, until a rebuild is clean", () => {
    const fixture = makeFixture()
    const repo = join(fixture.root, "repo")
    try {
      seed(fixture.root, repo)
      write(repo, "src/a.rs", "fn a() {}\n")
      write(repo, "src/b.rs", "fn b() {}\n")
      commitAll(repo, "drafts")
      installStub(fixture, stubProgram(responder))
      const result = runFlow(fixture, "port-compile", repo, {
        LLM4TS_PACK: "packs/smoke-port",
        LLM4TS_PORT_CONCURRENCY: "1"
      })
      assert.strictEqual(result.status, 0, failureReport("compile", result))
      const out = `${result.stdout}\n${result.stderr}`
      assert.include(out, "compile: round 1, 2 diagnostic(s) in 2 unit(s)")
      assert.include(out, "compile: clean after 1 round(s)")
      assert.isTrue(existsSync(join(repo, ".llm4ts/port/diagnostics-1.md")))
      assert.isTrue(existsSync(join(repo, ".llm4ts/port/compile-ledger.jsonl")))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
