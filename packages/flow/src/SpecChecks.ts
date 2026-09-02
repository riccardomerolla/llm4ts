import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ReviewIssue, ReviewResult } from "./Review.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

export class CoverageRule extends Schema.Class<CoverageRule>("CoverageRule")({
  name: Schema.String,
  files: Schema.String,
  unit: Schema.String
}) {}

const capture = (regex: RegExp, text: string): ReadonlyArray<string> => {
  const expression = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`
  )
  const values: Array<string> = []
  for (const match of text.matchAll(expression)) {
    values.push(match[1] ?? match[0])
  }
  return values
}

/**
 * Repo-relative paths matching `regex` and not matching `exclude`, sorted.
 * The regex is applied INSIDE discovery so the workspace's result cap counts
 * candidate units, not every file that shares the tree with them.
 */
export const matchingFiles = (
  workspace: WorkspaceShape,
  regex: string,
  exclude?: string
): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
  workspace
    .discover("**/*", {
      matching: new RegExp(regex),
      ...(exclude === undefined ? {} : { excluding: new RegExp(exclude) })
    })
    .pipe(Effect.map((paths) => [...paths].sort()))

export const coverageUnits = Effect.fn("@llm4ts/flow/SpecChecks.coverageUnits")(function* (
  workspace: WorkspaceShape,
  rules: ReadonlyArray<CoverageRule>
): Effect.fn.Return<Readonly<Record<string, ReadonlyArray<string>>>, WorkspaceError> {
  const paths = yield* workspace.discover()
  const result: Record<string, ReadonlyArray<string>> = {}
  for (const rule of rules) {
    const filePattern = new RegExp(rule.files)
    const unitPattern = new RegExp(rule.unit)
    const units: Array<string> = []
    for (const path of paths.filter((path) => filePattern.test(path))) {
      const contents = yield* workspace.read(path)
      for (const line of contents.split(/\r?\n/)) {
        for (const unit of capture(unitPattern, line)) {
          if (!units.includes(unit)) {
            units.push(unit)
          }
        }
      }
    }
    result[rule.name] = units
  }
  return result
})

export const coverage = Effect.fn("@llm4ts/flow/SpecChecks.coverage")(function* (
  workspace: WorkspaceShape,
  rules: ReadonlyArray<CoverageRule>,
  traceability: string
): Effect.fn.Return<ReviewResult, WorkspaceError> {
  const units = yield* coverageUnits(workspace, rules)
  const issues = rules.flatMap((rule) =>
    (units[rule.name] ?? []).flatMap((unit) =>
      traceability.includes(unit)
        ? []
        : [
            ReviewIssue.make({
              severity: "Critical",
              title: `uncovered ${rule.name}: ${unit}`,
              description:
                `'${unit}' exists in the legacy source but does not ` +
                "appear in the traceability matrix."
            })
          ]
    )
  )
  return ReviewResult.make({
    issues,
    summary: issues.length === 0 ? "coverage complete" : `${issues.length} unit(s) uncovered`
  })
})

const featureIssue = (path: string, contents: string): ReviewIssue | undefined => {
  const lines = contents.split(/\r?\n/).map((line) => line.trim())
  const scenarios = lines.filter(
    (line) => line.startsWith("Scenario:") || line.startsWith("Scenario Outline:")
  ).length
  const steps = lines.filter((line) =>
    ["Given ", "When ", "Then ", "And ", "But "].some((prefix) => line.startsWith(prefix))
  ).length
  const problem = !lines.some((line) => line.startsWith("Feature:"))
    ? "missing a 'Feature:' header"
    : scenarios === 0
      ? "contains no scenarios"
      : steps === 0
        ? "has scenarios but no Given/When/Then steps"
        : undefined
  return problem === undefined
    ? undefined
    : ReviewIssue.make({
        severity: "Critical",
        title: `malformed feature: ${path}`,
        description: problem,
        file: path
      })
}

export const features = Effect.fn("@llm4ts/flow/SpecChecks.features")(function* (
  workspace: WorkspaceShape,
  directory: string
): Effect.fn.Return<ReviewResult, WorkspaceError> {
  const prefix = directory.replace(/[\\/]+$/, "")
  const paths = (yield* workspace.discover("**/*.feature")).filter(
    (path) => path === prefix || path.startsWith(`${prefix}/`)
  )
  if (paths.length === 0) {
    return ReviewResult.make({
      issues: [
        ReviewIssue.make({
          severity: "Critical",
          title: "no feature files",
          description: `no .feature files found under ${directory}`
        })
      ],
      summary: "no features"
    })
  }
  const issues: Array<ReviewIssue> = []
  for (const path of paths) {
    const issue = featureIssue(path, yield* workspace.read(path))
    if (issue !== undefined) {
      issues.push(issue)
    }
  }
  return ReviewResult.make({
    issues,
    summary: issues.length === 0 ? "features well-formed" : `${issues.length} malformed`
  })
})
