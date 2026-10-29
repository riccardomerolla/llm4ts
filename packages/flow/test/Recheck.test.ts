import { assert, describe, it } from "@effect/vitest"
import {
  ReviewMemory,
  diffChunks,
  planRound,
  recheckPrompt,
  remember,
  standing,
  touchedFiles,
  type Candidate
} from "@llm4ts/flow/Recheck"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"

const section = (path: string, line: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    `+${line}`
  ].join("\n")

const issue = (title: string): ReviewIssue => ReviewIssue.make({ severity: "Warning", title })

const result = (...titles: ReadonlyArray<string>): ReviewResult =>
  ReviewResult.make({ issues: titles.map(issue) })

const candidate = (name: string, pattern = /.*/u, onlyWhenDirty = false): Candidate => ({
  name,
  matches: (files) => files.length === 0 || files.some((file) => pattern.test(file)),
  ...(onlyWhenDirty ? { onlyWhenDirty } : {})
})

const memoryOf = (
  reviewers: ReadonlyArray<{
    name: string
    status: "clean" | "dirty"
    findings?: ReadonlyArray<string>
    seen?: ReadonlyArray<string>
  }>
): ReviewMemory =>
  ReviewMemory.make({
    version: 1,
    round: 1,
    chunks: {},
    reviewers: reviewers.map((entry) => ({
      name: entry.name,
      status: entry.status,
      findings: (entry.findings ?? []).map(issue),
      seen: entry.seen ?? []
    }))
  })

describe("Recheck (ADR 0044)", () => {
  it("diffChunks keys each file of a unified diff", () => {
    const chunks = diffChunks([section("a.ts", "one"), section("b.ts", "two")].join("\n"))
    assert.deepStrictEqual(Object.keys(chunks).sort(), ["a.ts", "b.ts"])
  })

  it("touchedFiles names changed, added and removed files only", () => {
    const before = diffChunks([section("a.ts", "one"), section("b.ts", "two")].join("\n"))
    const after = diffChunks(
      [section("a.ts", "one"), section("b.ts", "three"), section("c.ts", "new")].join("\n")
    )
    assert.deepStrictEqual(touchedFiles(before, after), ["b.ts", "c.ts"])
    assert.deepStrictEqual(touchedFiles(after, before), ["b.ts", "c.ts"])
  })

  it("planRound with no memory reviews every matching candidate in full", () => {
    const plan = planRound([candidate("a"), candidate("b", /\.sql$/u)], undefined, ["x.ts"], [])
    assert.deepStrictEqual(plan, { full: ["a"], recheck: [] })
  })

  it("planRound re-checks a dirty reviewer and skips a clean one the fix brought nothing new", () => {
    const memory = memoryOf([
      { name: "a", status: "dirty", findings: ["bug"], seen: ["x.ts"] },
      { name: "b", status: "clean", seen: ["x.ts"] }
    ])
    assert.deepStrictEqual(
      planRound([candidate("a"), candidate("b")], memory, ["x.ts"], ["x.ts"]),
      {
        full: [],
        recheck: ["a"]
      }
    )
  })

  it("planRound reviews a clean lens in full when the fix touched a file it never saw", () => {
    const memory = memoryOf([
      { name: "a", status: "dirty", findings: ["bug"], seen: ["x.ts"] },
      { name: "b", status: "clean", seen: ["x.ts"] }
    ])
    const plan = planRound(
      [candidate("a"), candidate("b", /\.test\.ts$/u)],
      memory,
      ["x.ts", "x.test.ts"],
      ["x.test.ts"]
    )
    assert.deepStrictEqual(plan, { full: ["b"], recheck: ["a"] })
  })

  it("planRound never reruns a clean reviewer that runs only when dirty", () => {
    const memory = memoryOf([{ name: "judge", status: "clean", seen: ["x.ts"] }])
    const plan = planRound([candidate("judge", /.*/u, true)], memory, ["y.ts"], ["y.ts"])
    assert.deepStrictEqual(plan, { full: [], recheck: [] })
  })

  it("planRound reviews in full a candidate that never ran", () => {
    const memory = memoryOf([{ name: "a", status: "clean", seen: ["x.ts"] }])
    const plan = planRound([candidate("a"), candidate("b")], memory, ["x.ts"], [])
    assert.deepStrictEqual(plan, { full: ["b"], recheck: [] })
  })

  it("remember updates the reviewers that ran and keeps the others", () => {
    const before = memoryOf([
      { name: "a", status: "dirty", findings: ["bug"], seen: ["x.ts"] },
      { name: "b", status: "dirty", findings: ["slow"], seen: ["x.ts"] }
    ])
    const after = remember(
      before,
      2,
      { "x.ts": "f" },
      [{ name: "a", result: result() }],
      ["x.ts", "y.ts"]
    )
    assert.strictEqual(after.round, 2)
    assert.deepStrictEqual(after.chunks, { "x.ts": "f" })
    const [a, b] = after.reviewers
    assert.deepStrictEqual([a?.name, a?.status, a?.seen], ["a", "clean", ["x.ts", "y.ts"]])
    assert.deepStrictEqual(
      [b?.name, b?.status, b?.findings.map((finding) => finding.title)],
      ["b", "dirty", ["slow"]]
    )
  })

  it("remember starts a memory from nothing", () => {
    const after = remember(undefined, 1, {}, [{ name: "a", result: result("bug") }], ["x.ts"])
    assert.deepStrictEqual(
      after.reviewers.map((entry) => [entry.name, entry.status]),
      [["a", "dirty"]]
    )
  })

  it("standing merges only the dirty reviewers' findings", () => {
    const memory = memoryOf([
      { name: "a", status: "clean" },
      { name: "b", status: "dirty", findings: ["slow", "leak"] }
    ])
    assert.deepStrictEqual(
      standing(memory).issues.map((finding) => finding.title),
      ["slow", "leak"]
    )
  })

  it("recheckPrompt names each earlier finding, the touched files and the diff", () => {
    const prompt = recheckPrompt(
      "story s1",
      "DIFF-BODY",
      ["x.ts", "y.ts"],
      [issue("missing guard")]
    )
    assert.include(prompt, "re-check")
    assert.include(prompt, "missing guard")
    assert.include(prompt, "x.ts, y.ts")
    assert.include(prompt, "DIFF-BODY")
  })
})
