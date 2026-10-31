import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  stubProgram,
  write
} from "./support/smoke.ts"

// The stub plays every seat: the Chief of Staff plans two Researcher briefs
// (no Engineer, no Operator: the smoke has no coder to drive and no scripts
// to run), the Researcher reports, the goal check says reached, the Doc
// Writer drafts, the evidence lens finds nothing, the Memory Manager writes
// the note. Replies are chosen by prompt content.
const respondSource = `(prompt) => {
  if (prompt.includes("Propose the plan")) {
    return JSON.stringify({ deliverables: ["result.md", "design.md"], briefs: [
      { title: "Survey the auth module", owner: "Researcher", dependsOn: [], goal: "Map src/auth", scope: "src/auth", context: "Start at src/auth/index.ts", acceptance: ["Every entry point is listed"], verify: [], timebox: "10 turns", forbidden: "Editing", report: "reports/B1.md with the map, for result.md and design.md" },
      { title: "Read the standards", owner: "Researcher", dependsOn: [], goal: "List what applies", scope: "docs", context: "docs/standards", acceptance: ["Each standard is cited"], verify: [], timebox: "10 turns", forbidden: "Editing", report: "reports/B2.md with the citations, for result.md" }
    ] })
  }
  if (prompt.includes("Goal check after wave")) {
    return JSON.stringify({ reached: true, note: "Both briefs passed.", briefs: [] })
  }
  if (prompt.includes('"documents":')) {
    return JSON.stringify({ documents: [
      { name: "result.md", content: "# Result\\n\\n## Answer\\n\\nYes, behind the gateway.\\n\\n## Sources\\n\\n- reports/B1.md" },
      { name: "design.md", content: "# Design\\n\\nOne gateway, one auth service." }
    ] })
  }
  if (prompt.includes("Review lens:")) {
    return JSON.stringify({ findings: [] })
  }
  if (prompt.includes("Write the run note")) {
    return JSON.stringify({ decisions: ["Gateway: yes."], preferences: [], failed: [], pointers: ["reports/B1.md"] })
  }
  if (prompt.includes("You are the Researcher")) {
    return JSON.stringify({ status: "PASS", evidence: ["src/auth/index.ts"], summary: "Mapped.", questions: [], body: "## Map\\n\\n- index.ts" })
  }
  return JSON.stringify({ status: "BLOCKED", evidence: [], summary: "unexpected prompt", questions: [], body: "" })
}`

describe("taskforce", { timeout: smokeTimeout }, () => {
  it("runs a taskforce end to end from the command line and leaves the files", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)
    write(fixture.target, "src/auth/index.ts", "export const auth = 1\n")
    write(fixture.target, "docs/standards/api.md", "# API standard\n\nEvery API is versioned.\n")
    write(
      fixture.target,
      ".llm4ts/memory/auth.md",
      "# Auth module\n\n## Gateway\n\nKong fronts it.\n"
    )
    commitAll(fixture.target, "seed")

    const result = runFlow(
      fixture,
      "taskforce",
      fixture.target,
      {},
      "Can the auth module move behind the gateway?",
      [
        "--",
        "--agents",
        "Researcher,Reviewer,Memory Manager",
        "--context",
        "docs/standards",
        "--no-pause"
      ]
    )
    assert.strictEqual(result.status, 0, failureReport("taskforce", result))

    const dir = join(
      fixture.target,
      ".llm4ts",
      "taskforce",
      "can-the-auth-module-move-behind-the-gateway"
    )
    const plan = readFileSync(join(dir, "plan.md"), "utf8")
    assert.include(plan, "Status: done")
    assert.include(plan, "Cast: Chief of Staff, Researcher, Reviewer, Doc Writer, Memory Manager")
    assert.include(plan, "### B1. Survey the auth module")
    assert.include(plan, "- wave 1: reached — Both briefs passed.")
    assert.include(readFileSync(join(dir, "reports", "B1.md"), "utf8"), "Status: PASS")
    assert.include(readFileSync(join(dir, "result.md"), "utf8"), "Yes, behind the gateway.")
    assert.include(readFileSync(join(dir, "design.md"), "utf8"), "One gateway")
    assert.include(readFileSync(join(dir, "review.md"), "utf8"), "## Act on\n\n- none")
    assert.include(
      readFileSync(join(dir, "decisions.tsv"), "utf8"),
      "\tplan\tChief of Staff proposed 2 briefs\t"
    )
    assert.isTrue(existsSync(join(dir, "open-questions.md")))
    assert.include(
      readFileSync(
        join(
          fixture.target,
          ".llm4ts",
          "memory",
          "runs",
          "can-the-auth-module-move-behind-the-gateway.md"
        ),
        "utf8"
      ),
      "- Gateway: yes."
    )
    assert.include(result.stdout, "memory: recalled auth")
    assert.include(result.stdout, "taskforce can-the-auth-module-move-behind-the-gateway done")

    // A second run finds nothing to do.
    const again = runFlow(fixture, "taskforce", fixture.target, {}, undefined, [
      "--",
      "--run",
      "can-the-auth-module-move-behind-the-gateway"
    ])
    assert.strictEqual(again.status, 0, failureReport("taskforce again", again))
    assert.include(again.stdout, "is done")
  })

  it("stops after the plan unless --no-pause", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    initRepo(fixture.target)
    commitAll(fixture.target, "seed")
    const halted = runFlow(fixture, "taskforce", fixture.target, {}, "Gateway?", [
      "--",
      "--agents",
      "Researcher",
      "--no-memory"
    ])
    assert.notStrictEqual(halted.status, 0)
    assert.include(`${halted.stdout}\n${halted.stderr}`, "2 brief(s) proposed in")
    assert.include(
      readFileSync(join(fixture.target, ".llm4ts", "taskforce", "gateway", "plan.md"), "utf8"),
      "Status: planned"
    )
  })

  it("ejects the bundled cards and lists the runs", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    mkdirSync(fixture.target, { recursive: true })
    const ejected = runFlow(fixture, "taskforce", fixture.target, {}, undefined, [
      "--",
      "--eject-personas"
    ])
    assert.strictEqual(ejected.status, 0, failureReport("eject", ejected))
    assert.isTrue(existsSync(join(fixture.target, ".llm4ts", "personas", "Chief of Staff.md")))
    assert.isTrue(existsSync(join(fixture.target, ".llm4ts", "personas", "Memory Manager.md")))
    const listed = runFlow(fixture, "taskforce", fixture.target, {}, undefined, ["--", "--list"])
    assert.strictEqual(listed.status, 0, failureReport("list", listed))
    assert.include(listed.stdout, "no runs under")
    assert.include(listed.stdout, "Engineer (workspace, coder)")
  })
})
