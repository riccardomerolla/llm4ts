// Per-criterion test evidence (ADR 0042): every MVP acceptance criterion is
// encoded by tests whose names carry its tag, `[<story-id>#<n>]`, and the
// criterion is green only when the test run says so — from a JUnit XML
// report, or from one filtered test command per criterion. Pass/fail counts
// alone (GateTriage, OracleGuard) cannot say WHICH criterion holds.
import * as Schema from "effect/Schema"
import type { OracleRules } from "./OracleGuard.ts"
import { defaultOracleRules } from "./OracleGuard.ts"

/** The tag tests of a criterion carry in their name: `[story-id#2]` for its second criterion. */
export const criterionTag = (storyId: string, index: number): string => `[${storyId}#${index}]`

/** The tags of a story's MVP criteria, in order. */
export const criterionTags = (
  storyId: string,
  acceptance: ReadonlyArray<string>
): ReadonlyArray<string> => acceptance.map((_, index) => criterionTag(storyId, index + 1))

export const TestCaseStatus = Schema.Literals(["passed", "failed", "skipped"])
export type TestCaseStatus = typeof TestCaseStatus.Type

export interface TestCase {
  readonly name: string
  readonly classname: string
  readonly file: string | undefined
  readonly status: TestCaseStatus
}

const attribute = (attributes: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "u").exec(attributes)
  return match?.[1] === undefined ? undefined : unescapeXml(match[1])
}

const unescapeXml = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")

/**
 * The test cases of a JUnit XML report — the format vitest, jest, pytest,
 * Surefire/Gradle and cargo-nextest all write. A case with a `<failure>` or
 * `<error>` failed, one with `<skipped>` was skipped, any other passed.
 */
export const parseJUnit = (xml: string): ReadonlyArray<TestCase> => {
  const cases: Array<TestCase> = []
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[1] ?? ""
    const body = match[2] ?? ""
    const status: TestCaseStatus = /<(?:failure|error)\b/u.test(body)
      ? "failed"
      : /<skipped\b/u.test(body)
        ? "skipped"
        : "passed"
    cases.push({
      name: attribute(attributes, "name") ?? "",
      classname: attribute(attributes, "classname") ?? "",
      file: attribute(attributes, "file"),
      status
    })
  }
  return cases
}

/**
 * `missing`: no test names the criterion. `red`: one does and not all of
 * them pass. `green`: some do and every one passes.
 */
export const CriterionStatus = Schema.Literals(["missing", "red", "green"])
export type CriterionStatus = typeof CriterionStatus.Type

const named = (testCase: TestCase, tag: string): boolean =>
  testCase.name.includes(tag) || testCase.classname.includes(tag)

/**
 * A criterion's status from a report. A tag the report does not show but
 * the test sources carry (`written`) is red: a suite that cannot even load
 * — the module under test does not exist yet — reports no case.
 */
export const statusFromReport = (
  tag: string,
  cases: ReadonlyArray<TestCase>,
  written: boolean
): CriterionStatus => {
  const mine = cases.filter((testCase) => named(testCase, tag))
  if (mine.length === 0) {
    return written ? "red" : "missing"
  }
  return mine.every((testCase) => testCase.status === "passed") ? "green" : "red"
}

/**
 * Where the evidence comes from: the JUnit report the test gate writes
 * (`LLM4TS_TEST_REPORT`, relative to the app directory), or a command run
 * once per criterion with `{tag}` replaced (`LLM4TS_TEST_ONE`), green when
 * it exits 0.
 */
export type EvidenceSource =
  | { readonly _tag: "Report"; readonly path: string }
  | { readonly _tag: "Command"; readonly argv: ReadonlyArray<string> }

export const evidenceSourceFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): EvidenceSource | undefined => {
  const report = environment.LLM4TS_TEST_REPORT?.trim()
  if (report !== undefined && report.length > 0) {
    return { _tag: "Report", path: report }
  }
  const command = environment.LLM4TS_TEST_ONE?.trim()
  if (command !== undefined && (command.includes("{tag}") || command.includes("{tagRegex}"))) {
    return { _tag: "Command", argv: command.split(/\s+/u) }
  }
  return undefined
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The per-criterion command with its tag in place: `{tag}` verbatim,
 * `{tagRegex}` escaped for runners whose name filter is a regex (vitest `-t`,
 * jest `-t`, pytest `-k` takes neither — use `{tag}` there).
 */
export const commandFor = (argv: ReadonlyArray<string>, tag: string): ReadonlyArray<string> =>
  argv.map((part) => part.split("{tagRegex}").join(escapeRegex(tag)).split("{tag}").join(tag))

/** The changed paths that are test files by the oracle's rules: what a red phase freezes. */
export const testPaths = (
  paths: ReadonlyArray<string>,
  rules: OracleRules = defaultOracleRules
): ReadonlyArray<string> => {
  const pattern = new RegExp(rules.testFiles, "u")
  return paths.filter((path) => pattern.test(path))
}
