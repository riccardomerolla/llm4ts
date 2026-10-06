import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
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
  write,
  writeExecutable
} from "./support/smoke.ts"

/**
 * port-guide, port-ledger and port-tests with the seats stubbed (ADR 0028).
 * The stub answers the auditors, refuters, classifiers and comparers with
 * JSON, drafts a file when asked to port one, and writes the marker the
 * target test script checks when asked to fix a divergence.
 */
const responder = [
  "(prompt) => {",
  commonReplies,
  "  const port = /Write the ported file at: (\\S+)/.exec(prompt)",
  "  if (port) {",
  "    fs.mkdirSync(path.dirname(port[1]), { recursive: true })",
  '    fs.writeFileSync(port[1], "fn ported() {}\\n\\n// PORT STATUS\\n// confidence: high\\n// todos: 0\\n// notes: none\\n")',
  '    return "Drafted " + port[1]',
  "  }",
  '  if (prompt.includes("You audit a porting rulebook along one dimension")) {',
  '    return prompt.includes("dimension: error model")',
  '      ? JSON.stringify({ findings: [{ dimension: "error model", finding: "no rule for anyerror", evidence: "src/a.zig:1", proposedRule: "Map anyerror!T to Result<T, Error>." }] })',
  "      : JSON.stringify({ findings: [] })",
  "  }",
  '  if (prompt.includes("Compare the two drafts")) {',
  '    return JSON.stringify({ differences: ["the native draft used Vec"], findings: [] })',
  "  }",
  '  if (prompt.includes("Refuter")) {',
  '    return JSON.stringify({ holds: true, why: "the evidence shows it" })',
  "  }",
  '  if (prompt.includes("Classify every unit")) {',
  "    const units = [...prompt.matchAll(/^- unit: (\\S+)$/gm)].map((m) => m[1])",
  '    return JSON.stringify({ rows: units.map((unit) => ({ unit, class: "OWNED", evidence: "src/x.zig:1", confidence: "high" })) })',
  "  }",
  '  if (prompt.includes("ONLY runtime evidence")) {',
  '    fs.writeFileSync("FIXED", "yes\\n")',
  '    return "Fixed the divergence."',
  "  }",
  '  return "Acknowledged."',
  "}"
].join("\n")

const portPack = [
  "# Pack: smoke-port",
  "",
  "source: zig",
  "sources: ^src/.*\\.zig$",
  "target: {{dir}}/{{base}}.rs",
  "comment: //",
  "specs-dir: docs/port",
  "features-dir: docs/port/features",
  "",
  "## Ledger",
  "",
  "- unit: ^pub fn (\\w+)",
  "- classes: OWNED, UNKNOWN",
  "- question: Who owns the result?",
  "",
  "## Differential",
  "",
  "- tests: ^test/.*\\.test\\.sh$",
  "- legacy: sh scripts/legacy.sh {{file}}",
  "- target: sh scripts/target.sh {{file}}",
  "- timeout: 30",
  "",
  "## Audit",
  "",
  "- dimensions: error model, ownership"
].join("\n")

const seed = (root: string, repo: string): void => {
  write(root, "packs/smoke-port/pack.md", portPack)
  write(root, "packs/smoke-port/prompts/porting.md", "# Rules\n\n- Translate faithfully.\n")
  initRepo(repo)
  write(repo, "src/a.zig", "pub fn a() void {}\n")
  write(repo, "src/b.zig", "pub fn b() void {}\n")
  write(repo, "test/t.test.sh", "echo t\n")
  writeExecutable(repo, "scripts/legacy.sh", '#!/bin/sh\necho " Tests  2 passed (2)"\nexit 0\n')
  writeExecutable(
    repo,
    "scripts/target.sh",
    '#!/bin/sh\nif [ -f FIXED ]; then echo " Tests  2 passed (2)"; exit 0; fi\necho " Tests  1 failed | 1 passed (2)"\necho "expected 2 to be 3"\nexit 1\n'
  )
  commitAll(repo, "seeded")
}

const env = {
  LLM4TS_PACK: "packs/smoke-port",
  LLM4TS_PORT_CONCURRENCY: "1",
  LLM4TS_PORT_GUIDE_SAMPLE: "1"
}

describe(
  "port-guide, port-ledger, port-tests (model stubbed)",
  { timeout: smokeTimeout * 2 },
  () => {
    it("audits the rulebook, keeps what the refuters let stand, and appends the rule once approved", () => {
      const fixture = makeFixture()
      const repo = join(fixture.root, "repo")
      try {
        seed(fixture.root, repo)
        installStub(fixture, stubProgram(responder))
        const audit = runFlow(fixture, "port-guide", repo, env)
        assert.strictEqual(audit.status, 0, failureReport("audit", audit))
        const reportPath = join(repo, ".llm4ts/port/guide-audit.md")
        const report = readFileSync(reportPath, "utf8")
        assert.include(report, "findings kept after the refute: 1")
        assert.include(report, "+ - Map anyerror!T to Result<T, Error>.")
        assert.include(report, "the native draft used Vec")
        assert.isTrue(report.trimEnd().endsWith("- [ ] Approved"))
        assert.isTrue(existsSync(join(repo, ".llm4ts/port/trial/by-rules/src/a.rs")))

        write(
          repo,
          ".llm4ts/port/guide-audit.md",
          report.replace("- [ ] Approved", "- [x] Approved")
        )
        const apply = runFlow(fixture, "port-guide", repo, env)
        assert.strictEqual(apply.status, 0, failureReport("apply", apply))
        const rulebook = readFileSync(
          join(fixture.root, "packs/smoke-port/prompts/porting.md"),
          "utf8"
        )
        assert.include(rulebook, "- Map anyerror!T to Result<T, Error>.")
        assert.include(readFileSync(reportPath, "utf8"), "- [x] Applied")
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    })

    it("classifies every unit into a ledger beside the specs and commits it", () => {
      const fixture = makeFixture()
      const repo = join(fixture.root, "repo")
      try {
        seed(fixture.root, repo)
        installStub(fixture, stubProgram(responder))
        const result = runFlow(fixture, "port-ledger", repo, env)
        assert.strictEqual(result.status, 0, failureReport("ledger", result))
        const ledger = readFileSync(join(repo, "docs/port/ledger.tsv"), "utf8")
        assert.include(ledger, "src/a.zig\ta\tOWNED\tsrc/x.zig:1\thigh")
        assert.include(ledger, "src/b.zig\tb\tOWNED")
        assert.include(
          readFileSync(join(repo, ".git/logs/HEAD"), "utf8"),
          "port: ledger of 2 unit(s)"
        )
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    })

    it("baselines each test file on the legacy build, fixes the divergence, and is green next round", () => {
      const fixture = makeFixture()
      const repo = join(fixture.root, "repo")
      try {
        seed(fixture.root, repo)
        installStub(fixture, stubProgram(responder))
        const result = runFlow(fixture, "port-tests", repo, env)
        assert.strictEqual(result.status, 0, failureReport("tests", result))
        const out = `${result.stdout}\n${result.stderr}`
        assert.include(out, "round 1, 1 file(s): 0 pass, 1 red")
        assert.include(out, "green after 2 round(s)")
        assert.isTrue(existsSync(join(repo, ".llm4ts/port/tests/test-t-test-sh.baseline.json")))
        assert.include(
          readFileSync(join(repo, ".llm4ts/port/tests/report-1.md"), "utf8"),
          "diverge 1"
        )
        assert.include(
          readFileSync(join(repo, ".llm4ts/port/tests/report-2.md"), "utf8"),
          "pass 1, diverge 0"
        )
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    })
  }
)
