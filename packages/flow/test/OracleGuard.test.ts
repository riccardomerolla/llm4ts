import { assert, describe, it } from "@effect/vitest"
import {
  checkOracle,
  defaultOracleRules,
  oracleRulesFrom,
  parseUnifiedDiff,
  passedCountIn
} from "@llm4ts/flow/OracleGuard"

const deletion = [
  "diff --git a/src/features/counter/counter.test.ts b/src/features/counter/counter.test.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/features/counter/counter.test.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-import { it } from 'vitest'",
  "-it('increments', () => {})",
  "-"
].join("\n")

const skipped = [
  "diff --git a/src/features/counter/counter.test.ts b/src/features/counter/counter.test.ts",
  "index 1111111..2222222 100644",
  "--- a/src/features/counter/counter.test.ts",
  "+++ b/src/features/counter/counter.test.ts",
  "@@ -10,4 +10,5 @@ describe('counter', () => {",
  "   it('resets', () => {})",
  "-  it('increments', () => {",
  "+  // flaky on CI",
  "+  it.skip('increments', () => {",
  "     expect(1).toBe(2)",
  "   })"
].join("\n")

const sourceOnly = [
  "diff --git a/src/features/counter/counter.ts b/src/features/counter/counter.ts",
  "index 1111111..2222222 100644",
  "--- a/src/features/counter/counter.ts",
  "+++ b/src/features/counter/counter.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1",
  "+// it.skip( in a source file is nobody's business",
  " export const b = 2"
].join("\n")

describe("parseUnifiedDiff", () => {
  it("reads a deleted file", () => {
    const shape = parseUnifiedDiff(deletion)
    assert.deepStrictEqual(shape.deleted, ["src/features/counter/counter.test.ts"])
    assert.deepStrictEqual(shape.added, [])
  })

  it("numbers added lines from the hunk header, skipping removed lines", () => {
    const shape = parseUnifiedDiff(skipped)
    assert.deepStrictEqual(shape.deleted, [])
    assert.deepStrictEqual(
      shape.added.map((line) => [line.file, line.line, line.text.trim()]),
      [
        ["src/features/counter/counter.test.ts", 11, "// flaky on CI"],
        ["src/features/counter/counter.test.ts", 12, "it.skip('increments', () => {"]
      ]
    )
  })

  it("an empty or unrelated diff has nothing", () => {
    assert.deepStrictEqual(parseUnifiedDiff(""), { deleted: [], added: [] })
    assert.deepStrictEqual(parseUnifiedDiff("not a diff\n"), { deleted: [], added: [] })
  })
})

describe("checkOracle", () => {
  it("a deleted test file is a Critical naming the file", () => {
    const issues = checkOracle(parseUnifiedDiff(deletion), undefined, defaultOracleRules, false)
    assert.strictEqual(issues.length, 1)
    assert.strictEqual(issues[0]?.severity, "Critical")
    assert.include(issues[0]?.title ?? "", "test file deleted")
    assert.strictEqual(issues[0]?.file, "src/features/counter/counter.test.ts")
  })

  it("an added skip marker in a test file is a Critical with file and line", () => {
    const issues = checkOracle(parseUnifiedDiff(skipped), undefined, defaultOracleRules, false)
    assert.strictEqual(issues.length, 1)
    assert.include(issues[0]?.title ?? "", ".skip(")
    assert.strictEqual(issues[0]?.line, 12)
  })

  it("a marker in a source file is not the oracle's business", () => {
    assert.deepStrictEqual(
      checkOracle(parseUnifiedDiff(sourceOnly), undefined, defaultOracleRules, false),
      []
    )
  })

  it("the same diff with testsChange declared is clean", () => {
    assert.deepStrictEqual(
      checkOracle(parseUnifiedDiff(deletion), undefined, defaultOracleRules, true),
      []
    )
  })

  it("a passed-count drop is a Critical only when both counts are known", () => {
    const empty = parseUnifiedDiff("")
    assert.strictEqual(
      checkOracle(empty, { base: 12, current: 11 }, defaultOracleRules, false).length,
      1
    )
    assert.strictEqual(
      checkOracle(empty, { base: 12, current: 12 }, defaultOracleRules, false).length,
      0
    )
    assert.strictEqual(
      checkOracle(empty, { base: undefined, current: 11 }, defaultOracleRules, false).length,
      0
    )
    assert.strictEqual(
      checkOracle(empty, { base: 12, current: undefined }, defaultOracleRules, false).length,
      0
    )
  })

  it("test files are recognised across ecosystems by default", () => {
    const testFile = new RegExp(defaultOracleRules.testFiles, "u")
    for (const path of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/a.ts",
      "tests/a.py",
      "test_a.py",
      "src/test/java/FooTest.java",
      "src/FooTests.cs",
      "pkg/a_test.go",
      "src/lib_test.rs"
    ]) {
      assert.isTrue(testFile.test(path), path)
    }
    for (const path of ["src/a.ts", "src/testimony.ts", "docs/latest.md"]) {
      assert.isFalse(testFile.test(path), path)
    }
  })

  it("a pack extends the markers and may replace the test-file pattern", () => {
    const rules = oracleRulesFrom({ tests: "^spec/", markers: ["@Flaky"] })
    assert.strictEqual(rules.testFiles, "^spec/")
    assert.include(rules.markers, "@Flaky")
    assert.include(rules.markers, ".skip(")
    const added = parseUnifiedDiff(
      [
        "diff --git a/spec/FooSpec.java b/spec/FooSpec.java",
        "--- a/spec/FooSpec.java",
        "+++ b/spec/FooSpec.java",
        "@@ -1,1 +1,2 @@",
        "+@Flaky",
        " class FooSpec {}"
      ].join("\n")
    )
    assert.strictEqual(checkOracle(added, undefined, rules, false).length, 1)
  })
})

describe("passedCountIn", () => {
  it("reads the summary lines of the runners it knows", () => {
    assert.strictEqual(
      passedCountIn(" Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 11 passed (12)"),
      11
    )
    assert.strictEqual(passedCountIn("Tests:       1 failed, 11 passed, 12 total"), 11)
    assert.strictEqual(passedCountIn("========= 11 passed, 1 failed in 2.31s ========="), 11)
    assert.strictEqual(passedCountIn("test result: ok. 11 passed; 0 failed; 0 ignored"), 11)
    assert.strictEqual(passedCountIn("\n  11 passing (2s)\n  1 failing"), 11)
    assert.strictEqual(
      passedCountIn(
        "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\nTests run: 12, Failures: 1, Errors: 0, Skipped: 1"
      ),
      10
    )
  })

  it("is undefined when no summary it knows is present", () => {
    assert.isUndefined(passedCountIn("error TS2322: nope"))
    assert.isUndefined(passedCountIn(""))
  })
})
