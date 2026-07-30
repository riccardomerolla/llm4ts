import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  commitAll,
  commonReplies,
  failureReport,
  git,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  stubProgram,
  write,
  writeExecutable,
  type Fixture
} from "./support/smoke.ts"

/**
 * Phase 3 with the model stubbed. The stub stands in for the coding agent's
 * edits: asked to implement the first task it writes a failing acceptance
 * test, and asked for the second it makes that test pass — so the flow's
 * red-tests-first invariant and its build/test gate switching are exercised
 * for real, not simulated.
 */
const responder = [
  "(prompt) => {",
  commonReplies,
  // Task asks arrive through the coder chat as free text carrying the task's
  // DESCRIPTION (Plan#taskPrompt), not its title. The chat is shared across
  // tasks, so every ask replays the whole conversation — act on whichever
  // instruction appears LAST, which is the one actually being asked now.
  '  const encode = prompt.lastIndexOf("Encode Rule 1 as an acceptance test")',
  '  const implement = prompt.lastIndexOf("Make the acceptance test pass")',
  "  if (implement >= 0 && implement > encode) {",
  '    fs.writeFileSync("IMPLEMENTED", "done\\n")',
  '    return "Implemented transfer posting; the acceptance test now passes."',
  "  }",
  "  if (encode >= 0) {",
  '    fs.writeFileSync("acceptance.txt", "asserts rule 1\\n")',
  '    return "Wrote the failing acceptance test."',
  "  }",
  '  return "Acknowledged."',
  "}"
].join("\n")

const seedTarget = (fixture: Fixture): void => {
  initRepo(fixture.target)
  write(fixture.target, "docs/specs/ACCTXFR.md", "# ACCTXFR\n\nRule 1: post the ledger.\n")
  write(fixture.target, "docs/specs/rules.txt", "0100-VALIDATE-INPUT\n")
  write(fixture.target, "features/acctxfr.feature", "Feature: ACCTXFR\n")
  write(
    fixture.target,
    "docs/modernization/plan.md",
    [
      "# Plan: meridian-transfers",
      "",
      "## [ ] Encode the specs as failing acceptance tests",
      "Encode Rule 1 as an acceptance test.",
      "",
      "## [ ] Implement transfer posting",
      "Make the acceptance test pass.",
      ""
    ].join("\n")
  )
  writeExecutable(fixture.target, "scripts/build.sh", "#!/bin/sh\nexit 0\n")
  // Red until the coder writes the marker: the gate is a real subprocess.
  writeExecutable(
    fixture.target,
    "scripts/test.sh",
    '#!/bin/sh\nif [ -f IMPLEMENTED ]; then exit 0; fi\necho "acceptance test failed" >&2\nexit 1\n'
  )
  commitAll(fixture.target, "seeded target")
}

describe("modernize-implement end to end (model stubbed)", () => {
  it("implements each task behind the pack's gates and clears the compliance judge", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-implement", fixture.target)
      assert.strictEqual(result.status, 0, failureReport("implement", result))

      // The plan's epic branch was created and both tasks committed on it.
      const branch = git(fixture.target, "rev-parse", "--abbrev-ref", "HEAD").trim()
      assert.strictEqual(branch, "meridian-transfers")
      const log = git(fixture.target, "log", "--oneline")
      assert.include(log, "meridian-transfers: Encode the specs as failing acceptance tests")
      assert.include(log, "meridian-transfers: Implement transfer posting")

      // The coder's simulated edits landed and were committed, not left dirty.
      assert.isTrue(existsSync(join(fixture.target, "acceptance.txt")))
      assert.isTrue(existsSync(join(fixture.target, "IMPLEMENTED")))
      assert.strictEqual(git(fixture.target, "status", "--porcelain").trim(), "")

      // The plan is persisted with both tasks marked complete, so a rerun resumes.
      const plan = readFileSync(join(fixture.target, "docs/modernization/plan.md"), "utf8")
      assert.include(plan, "## [x] Encode the specs as failing acceptance tests")
      assert.include(plan, "## [x] Implement transfer posting")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("aborts when the first task's acceptance tests pass before implementation", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      // A test gate that is green from the start: the tests encode nothing.
      writeExecutable(fixture.target, "scripts/test.sh", "#!/bin/sh\nexit 0\n")
      commitAll(fixture.target, "green tests")
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-implement", fixture.target)
      assert.notStrictEqual(result.status, 0, "a vacuous test suite must fail the flow")
      assert.include(
        `${result.stdout}${result.stderr}`,
        "pass before any implementation",
        "the abort should name the red-tests-first invariant"
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("refuses to start when legacy source sits inside the target workspace", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      // A stray COBOL file matches the pack's `sources:` regex.
      write(fixture.target, "legacy/ACCTXFR.cbl", "       IDENTIFICATION DIVISION.\n")
      commitAll(fixture.target, "leak legacy source")
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-implement", fixture.target)
      assert.notStrictEqual(result.status, 0, "the clean-room wall must stop the run")
      const output = `${result.stdout}${result.stderr}`
      assert.include(output, "clean-room wall breached")
      assert.include(output, "legacy/ACCTXFR.cbl", "the breach should name the offending file")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
