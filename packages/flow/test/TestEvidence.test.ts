import { assert, describe, it } from "@effect/vitest"
import {
  commandFor,
  criterionTag,
  criterionTags,
  evidenceSourceFromEnvironment,
  parseJUnit,
  statusFromReport,
  testPaths
} from "@llm4ts/flow/TestEvidence"

const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="src/balance.test.ts" tests="4">
    <testcase classname="src/balance.test.ts" name="balance &gt; [conto#1] shows the balance" time="0.01"/>
    <testcase classname="src/balance.test.ts" name="balance &gt; [conto#2] lists movements" time="0.01">
      <failure message="expected 3 to be 2">AssertionError</failure>
    </testcase>
    <testcase classname="src/balance.test.ts" name="[conto#2] empty list" time="0.01"></testcase>
    <testcase classname="src/balance.test.ts" name="[conto#3] paginates" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`

describe("TestEvidence", () => {
  it("tags criteria by story and position, from 1", () => {
    assert.strictEqual(criterionTag("conto", 2), "[conto#2]")
    assert.deepStrictEqual(criterionTags("conto", ["a", "b"]), ["[conto#1]", "[conto#2]"])
  })

  it("reads passed, failed and skipped cases from a JUnit report", () => {
    const cases = parseJUnit(report)
    assert.deepStrictEqual(
      cases.map((testCase) => [testCase.name, testCase.status]),
      [
        ["balance > [conto#1] shows the balance", "passed"],
        ["balance > [conto#2] lists movements", "failed"],
        ["[conto#2] empty list", "passed"],
        ["[conto#3] paginates", "skipped"]
      ]
    )
  })

  it("a criterion is green only when every tagged case passes", () => {
    const cases = parseJUnit(report)
    assert.strictEqual(statusFromReport("[conto#1]", cases, true), "green")
    assert.strictEqual(statusFromReport("[conto#2]", cases, true), "red")
    // Skipped is not passed: a skip marker cannot turn an outcome green.
    assert.strictEqual(statusFromReport("[conto#3]", cases, true), "red")
  })

  it("a tag the report does not show is red when written, missing when not", () => {
    assert.strictEqual(statusFromReport("[conto#4]", [], true), "red")
    assert.strictEqual(statusFromReport("[conto#4]", [], false), "missing")
  })

  it("the source is the report path first, then a per-criterion command with a tag slot", () => {
    assert.deepStrictEqual(
      evidenceSourceFromEnvironment({ LLM4TS_TEST_REPORT: "reports/junit.xml" }),
      { _tag: "Report", path: "reports/junit.xml" }
    )
    assert.deepStrictEqual(
      evidenceSourceFromEnvironment({ LLM4TS_TEST_ONE: "pnpm vitest run -t {tagRegex}" }),
      { _tag: "Command", argv: ["pnpm", "vitest", "run", "-t", "{tagRegex}"] }
    )
    assert.isUndefined(evidenceSourceFromEnvironment({ LLM4TS_TEST_ONE: "pnpm test" }))
    assert.isUndefined(evidenceSourceFromEnvironment({}))
  })

  it("fills the tag verbatim or escaped for a regex filter", () => {
    assert.deepStrictEqual(commandFor(["pytest", "-k", "{tag}"], "[a#1]"), [
      "pytest",
      "-k",
      "[a#1]"
    ])
    assert.deepStrictEqual(commandFor(["vitest", "-t", "{tagRegex}"], "[a#1]"), [
      "vitest",
      "-t",
      "\\[a#1\\]"
    ])
  })

  it("freezes only test files", () => {
    assert.deepStrictEqual(
      testPaths(["src/a/index.ts", "src/a/a.test.ts", "tests/test_a.py", "src/a/stub.ts"]),
      ["src/a/a.test.ts", "tests/test_a.py"]
    )
  })
})
