import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The extraction → seeding half of the pipeline, with the model stubbed the
 * same way `modernize-survey.smoke.test.ts` stubs it. What this proves without
 * a provider: extraction writes the four per-program artifacts and commits per
 * program; the gate is layered and its verdicts are cached; the spec pack ships
 * UNAPPROVED; seeding refuses to run until a human flips the marker; and once
 * approved, only specs cross the clean-room wall — never legacy source.
 */
const stubClaude = `#!/usr/bin/env node
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  const program = /ONE source unit of this repository: \\S*?([A-Z0-9]+)\\.(cbl|CBL|jcl|JCL)/.exec(prompt)
  let reply
  if (program !== null) {
    const name = program[1]
    reply = {
      spec: "# " + name + "\\n\\nRule 1: the unit performs its documented work.\\n",
      feature:
        "Feature: " + name + "\\n\\n  Scenario: happy path\\n" +
        "    Given a valid request\\n    When " + name + " runs\\n    Then it succeeds\\n",
      traceability:
        name === "RUNJOB"
          ? "STEP1 — Rule 1\\n"
          : "0100-VALIDATE-INPUT — Rule 1\\n0200-POST-LEDGER — Rule 1\\n0100-COMPUTE-FEE — Rule 1\\n",
      mapping: "LEDGER table -> Ledger entity\\n"
    }
  } else if (prompt.includes("planning assistant")) {
    reply = {
      epicId: "meridian-transfers",
      tasks: [
        { title: "Encode the specs as failing acceptance tests", description: "Rule 1", completed: false },
        { title: "Implement transfer posting", description: "Rule 1", completed: false }
      ]
    }
  } else {
    // The judge: full marks on every dimension so the gate clears in one round.
    reply = {
      scores: [
        { name: "completeness", score: 2, reasoning: "every rule captured" },
        { name: "faithfulness", score: 2, reasoning: "grounded in source" },
        { name: "testability", score: 2, reasoning: "scenarios are concrete" }
      ],
      summary: "clean"
    }
  }
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
  emit({ type: "system", subtype: "init", model: "stub-claude-1" })
  emit({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(reply) }] } })
  emit({ type: "result", usage: { input_tokens: 200, output_tokens: 80 } })
})
`

const sources: Readonly<Record<string, string>> = {
  "cobol/ACCTXFR.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. ACCTXFR.",
    "       PROCEDURE DIVISION.",
    "       0100-VALIDATE-INPUT.",
    "           CALL 'FEECALC'.",
    "       0200-POST-LEDGER.",
    "           EXIT.",
    ""
  ].join("\n"),
  "cobol/FEECALC.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. FEECALC.",
    "       DATA DIVISION.",
    "       01  WS-AMOUNT   PIC S9(7)V99 COMP-3.",
    "       PROCEDURE DIVISION.",
    "       0100-COMPUTE-FEE.",
    "           EXIT.",
    ""
  ].join("\n"),
  "jcl/RUNJOB.JCL": ["//RUNJOB   JOB", "//STEP1    EXEC PGM=ACCTXFR", ""].join("\n")
}

interface Fixture {
  readonly root: string
  readonly legacy: string
  readonly target: string
  readonly binDir: string
}

const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", [...args], { cwd, stdio: "ignore" })
}

const initRepo = (path: string): void => {
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "smoke@llm4ts.test")
  git(path, "config", "user.name", "llm4ts smoke")
}

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "llm4ts-pipeline-smoke-"))
  const legacy = join(root, "legacy")
  const target = join(root, "target")
  const binDir = join(root, "bin")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(target, { recursive: true })

  for (const [path, contents] of Object.entries(sources)) {
    const full = join(legacy, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  const stubPath = join(binDir, "claude")
  writeFileSync(stubPath, stubClaude)
  chmodSync(stubPath, 0o755)

  initRepo(legacy)
  git(legacy, "add", "-A")
  git(legacy, "commit", "-qm", "estate baseline")
  initRepo(target)

  return { root, legacy, target, binDir }
}

const runFlow = (
  fixture: Fixture,
  flow: string,
  repo: string,
  extraEnv: Readonly<Record<string, string>> = {}
): SpawnSyncReturns<string> =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(flowsRoot, `${flow}.ts`), "--repo", repo],
    {
      cwd: flowsRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        LLM4TS_PACK: "packs/cobol-springboot",
        LLM4TS_CODER: "claude",
        LLM4TS_VERBOSITY: "quiet",
        ...extraEnv
      }
    }
  )

const failureReport = (label: string, result: SpawnSyncReturns<string>): string =>
  `${label} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`

describe("modernize extract → seed end to end (model stubbed)", () => {
  it("extracts a judged spec pack, gates approval, then seeds the target", () => {
    const fixture = makeFixture()
    try {
      // ---- Phase 1: extract -------------------------------------------------
      const extract = runFlow(fixture, "modernize-extract", fixture.legacy)
      assert.strictEqual(extract.status, 0, failureReport("extract", extract))

      const modDir = join(fixture.legacy, "docs", "modernization")
      const readLegacy = (name: string): string => readFileSync(join(modDir, name), "utf8")

      // Every program got its four artifacts.
      for (const program of ["ACCTXFR", "FEECALC", "RUNJOB"]) {
        assert.isTrue(
          existsSync(join(modDir, "specs", `${program}.md`)),
          `missing spec for ${program}`
        )
        assert.isTrue(
          existsSync(join(modDir, "features", `${program.toLowerCase()}.feature`)),
          `missing feature for ${program}`
        )
        assert.isTrue(
          existsSync(join(modDir, "traceability", `${program}.md`)),
          `missing traceability fragment for ${program}`
        )
        assert.isTrue(existsSync(join(modDir, "mapping", `${program}.md`)), `missing mapping`)
        // The judge verdict is cached and fingerprinted, so a rerun is free.
        assert.isTrue(
          existsSync(join(modDir, "gate", `${program}.json`)),
          `missing cached gate verdict for ${program}`
        )
      }

      // FEECALC declares COMP-3, so extraction tagged it with the packed-decimal
      // pattern card; implementation later injects exactly those cards.
      assert.include(
        readLegacy(join("traceability", "FEECALC.md")),
        "Patterns: PAT-COBOL-001",
        "the COMP-3 pattern card should be tagged on FEECALC"
      )

      // rules.txt freezes the rule universe verification reports against.
      const rules = readLegacy("rules.txt")
        .split("\n")
        .filter((line) => line.length > 0)
      assert.includeMembers(rules, ["0100-VALIDATE-INPUT", "0200-POST-LEDGER", "0100-COMPUTE-FEE"])

      // The pack cleared its gate but still ships UNAPPROVED.
      const readme = readLegacy("README.md")
      assert.include(readme, "PASSED")
      assert.include(readme, "- [ ] Approved")
      assert.isTrue(existsSync(join(modDir, "plan.md")), "a cleared gate should produce a plan")

      // Extraction commits per program plus the draft and the verdict.
      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: fixture.legacy,
        encoding: "utf8"
      })
      for (const program of ["ACCTXFR", "FEECALC", "RUNJOB"]) {
        assert.include(log, `spec ${program}`)
      }

      // ---- Phase 2: seed refuses an unapproved pack -------------------------
      const refused = runFlow(fixture, "modernize-seed", fixture.target, {
        LLM4TS_LEGACY_REPO: fixture.legacy
      })
      assert.notStrictEqual(refused.status, 0, "seed must refuse an unapproved spec pack")
      assert.include(`${refused.stdout}${refused.stderr}`, "approval required")

      // ---- Phase 2: seed after a human approves -----------------------------
      writeFileSync(join(modDir, "README.md"), readme.replace("- [ ] Approved", "- [x] Approved"))
      git(fixture.legacy, "add", "-A")
      git(fixture.legacy, "commit", "-qm", "approve the spec pack")

      const seed = runFlow(fixture, "modernize-seed", fixture.target, {
        LLM4TS_LEGACY_REPO: fixture.legacy,
        LLM4TS_APPROVER: "smoke-tester"
      })
      assert.strictEqual(seed.status, 0, failureReport("seed", seed))

      // The scaffold landed and the specs crossed the wall.
      assert.isTrue(
        existsSync(join(fixture.target, "pom.xml")),
        "scaffold should seed an empty target"
      )
      for (const program of ["ACCTXFR", "FEECALC", "RUNJOB"]) {
        assert.isTrue(
          existsSync(join(fixture.target, "docs", "specs", `${program}.md`)),
          `spec for ${program} did not cross to the target`
        )
      }
      assert.isTrue(
        existsSync(join(fixture.target, "src", "test", "resources", "features", "acctxfr.feature")),
        "features should land in the pack's features-dir"
      )
      assert.isTrue(existsSync(join(fixture.target, "docs", "specs", "rules.txt")))

      // The clean-room wall: NO legacy source may exist in the target.
      const leaked = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: fixture.target, encoding: "utf8" }
      )
        .split("\n")
        .filter((path) => /\.(cbl|CBL|cpy|CPY|jcl|JCL)$/.test(path))
      assert.deepStrictEqual(leaked, [], "legacy source leaked across the clean-room wall")

      // Provenance is the clean-room receipt.
      const provenance: unknown = JSON.parse(
        readFileSync(join(fixture.target, "docs", "modernization", "provenance.json"), "utf8")
      )
      assert.isObject(provenance)
      const manifest = readFileSync(
        join(fixture.target, "docs", "modernization", "provenance.json"),
        "utf8"
      )
      assert.include(manifest, '"pack":"cobol-springboot"')
      assert.include(manifest, '"approvedBy":"smoke-tester"')
      assert.include(manifest, "ACCTXFR", "spec hashes should name the specs they cover")

      // The plan was re-parsed and materialized for modernize-implement.
      const plan = readFileSync(join(fixture.target, "docs", "modernization", "plan.md"), "utf8")
      assert.include(plan, "meridian-transfers")
      assert.include(plan, "Encode the specs as failing acceptance tests")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
