// The oracle guard (ADR 0027, decision 4): a change may not delete a test
// file, add a skip or focus marker, or lower the passed-test count unless
// its plan entry says it may. Deterministic, from the diff and the gate
// output; a violation is a gate failure the fix round can undo.
import * as Schema from "effect/Schema"
import { ReviewIssue } from "./Review.ts"

export class OracleRules extends Schema.Class<OracleRules>("OracleRules")({
  /** Regex source: a path matching it is a test file. */
  testFiles: Schema.String,
  /** Substrings whose appearance on an added line marks a skipped or focused test. */
  markers: Schema.Array(Schema.String)
}) {}

export const defaultOracleRules = OracleRules.make({
  testFiles:
    "(?:^|/)(?:__tests__|tests?|spec|src/test)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$|_test\\.(?:go|py|rs)$|Tests?\\.(?:java|kt|scala|cs)$|^tests?_.*\\.py$",
  markers: [
    ".skip(",
    ".only(",
    "xit(",
    "xdescribe(",
    "xtest(",
    "test.todo(",
    "it.todo(",
    "@Ignore",
    "@Disabled",
    "@pytest.mark.skip",
    "#[ignore]"
  ]
})

/** The parsed body of a pack's `## Oracle` section: `- tests: <regex>` and `- markers: a, b`. */
export const oracleRulesFrom = (fields: {
  readonly tests?: string
  readonly markers?: ReadonlyArray<string>
}): OracleRules =>
  OracleRules.make({
    testFiles: fields.tests ?? defaultOracleRules.testFiles,
    markers: [...defaultOracleRules.markers, ...(fields.markers ?? [])]
  })

export interface AddedLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface DiffShape {
  /** Files the diff deletes outright. */
  readonly deleted: ReadonlyArray<string>
  /** Lines the diff adds, with the path and the new line number. */
  readonly added: ReadonlyArray<AddedLine>
}

const fileHeader = /^diff --git a\/(.+?) b\/(.+)$/u
const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u

/** The deletions and added lines of a unified diff; pure, tolerant of noise between files. */
export const parseUnifiedDiff = (diff: string): DiffShape => {
  const deleted: Array<string> = []
  const added: Array<AddedLine> = []
  let file: string | undefined
  let line = 0
  let inHunk = false
  for (const raw of diff.split(/\r?\n/u)) {
    const header = fileHeader.exec(raw)
    if (header !== null) {
      file = header[2]
      inHunk = false
      continue
    }
    if (file === undefined) continue
    if (raw.startsWith("deleted file mode")) {
      deleted.push(file)
      continue
    }
    const hunk = hunkHeader.exec(raw)
    if (hunk !== null) {
      line = Number.parseInt(hunk[1] ?? "0", 10)
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith("+++") || raw.startsWith("---")) continue
    if (raw.startsWith("+")) {
      added.push({ file, line, text: raw.slice(1) })
      line += 1
    } else if (raw.startsWith("-")) {
      // a removed line: the new file's numbering does not advance
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      line += 1
    }
  }
  return { deleted, added }
}

const vitestLike = /\bTests\b[^\n]*?(\d+)\s+passed/u
const jestLike = /\bTests:\s[^\n]*?(\d+)\s+passed/u
const pytestLike = /(?:^|\n)[^\n]*?\b(\d+)\s+passed\b[^\n]*\bin\s+[\d.]+s/u
const cargoLike = /test result:[^\n]*?(\d+)\s+passed/u
const mochaLike = /(?:^|\n)\s*(\d+)\s+passing\b/u
const junitLike =
  /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/gu

/**
 * The passed-test count in a test runner's output, when a summary line the
 * guard knows is present (Vitest, Jest, pytest, cargo test, mocha, JUnit
 * via Maven/Gradle); `undefined` otherwise, which the guard reports as an
 * Info rather than a verdict.
 */
export const passedCountIn = (output: string): number | undefined => {
  for (const pattern of [vitestLike, jestLike, cargoLike, pytestLike, mochaLike]) {
    const match = pattern.exec(output)
    if (match?.[1] !== undefined) {
      return Number.parseInt(match[1], 10)
    }
  }
  // Maven prints a line per class and one grand total; the largest run is the total.
  let largestRun = -1
  let passedOfLargest: number | undefined
  junitLike.lastIndex = 0
  for (let match = junitLike.exec(output); match !== null; match = junitLike.exec(output)) {
    const run = Number.parseInt(match[1] ?? "0", 10)
    const failures = Number.parseInt(match[2] ?? "0", 10)
    const errors = Number.parseInt(match[3] ?? "0", 10)
    const skipped = Number.parseInt(match[4] ?? "0", 10)
    if (run >= largestRun) {
      largestRun = run
      passedOfLargest = run - failures - errors - skipped
    }
  }
  return passedOfLargest
}

export interface OracleCounts {
  /** Tests passing on the base, from its baseline; `undefined` when unknown. */
  readonly base: number | undefined
  /** Tests passing on the change, from its test gate; `undefined` when unknown. */
  readonly current: number | undefined
}

export const oracleIssuePrefix = "oracle: "

/**
 * The guard's verdict on a change: one Critical per deleted test file, one
 * per added marker (with `file:line`), one for a passed-count drop; empty
 * when `declared` (the plan entry says tests may change). Counts are judged
 * only when both are known; a caller reports the unknown case as an Info.
 */
export const checkOracle = (
  diff: DiffShape,
  counts: OracleCounts | undefined,
  rules: OracleRules,
  declared: boolean
): ReadonlyArray<ReviewIssue> => {
  if (declared) {
    return []
  }
  const testFile = new RegExp(rules.testFiles, "u")
  const issues: Array<ReviewIssue> = []
  for (const path of diff.deleted) {
    if (testFile.test(path)) {
      issues.push(
        ReviewIssue.make({
          severity: "Critical",
          title: `${oracleIssuePrefix}test file deleted: ${path}`,
          description:
            "Restore it. A story may not delete a test unless its plan entry declares `testsChange: true`.",
          file: path
        })
      )
    }
  }
  for (const line of diff.added) {
    if (!testFile.test(line.file)) continue
    const marker = rules.markers.find((candidate) => line.text.includes(candidate))
    if (marker === undefined) continue
    issues.push(
      ReviewIssue.make({
        severity: "Critical",
        title: `${oracleIssuePrefix}skip or focus marker added: ${marker.trim()}`,
        description: `${line.file}:${line.line}: ${line.text.trim()}\nRemove the marker and make the test pass, or report the test as wrong in your Findings.`,
        file: line.file,
        line: line.line
      })
    )
  }
  if (counts?.base !== undefined && counts.current !== undefined && counts.current < counts.base) {
    issues.push(
      ReviewIssue.make({
        severity: "Critical",
        title: `${oracleIssuePrefix}fewer tests pass than on the base (${counts.current} < ${counts.base})`,
        description:
          "Tests were removed, skipped or no longer discovered. Restore them; declare `testsChange: true` on the story if the change is intended."
      })
    )
  }
  return issues
}

export const isOracleIssue = (issue: ReviewIssue): boolean =>
  issue.title.startsWith(oracleIssuePrefix)
