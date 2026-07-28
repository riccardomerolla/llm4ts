import { assert, describe, it } from "@effect/vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { cachedReview } from "@llm4ts/flow/ReviewCache"
import { ReviewResult } from "@llm4ts/flow/Review"
import { CoverageRule, coverage, features } from "@llm4ts/flow/SpecChecks"
import {
  SurveyEdge,
  mergeSurveyEdges,
  renderSurveyInventory,
  surveyGraph
} from "@llm4ts/flow/Survey"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { reviewFingerprint } from "@llm4ts/runner/ReviewFingerprint"

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-review-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
)

const memoryFiles = (files: Ref.Ref<Readonly<Record<string, string>>>): PlainFileStoreShape => ({
  read: (path) => Ref.get(files).pipe(Effect.map((current) => current[path])),
  writeAtomic: (path, contents) =>
    Ref.update(files, (current) => ({ ...current, [path]: contents })),
  append: (path, contents) =>
    Ref.update(files, (current) => ({
      ...current,
      [path]: `${current[path] ?? ""}${contents}`
    })),
  remove: (_path) => Effect.void,
  hashSha256: (_path) => Effect.succeed("")
})

describe("review cache", () => {
  it.effect("reuses matching content and re-evaluates changed/corrupt entries", () =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const evaluations = yield* Ref.make(0)
      const store = memoryFiles(files)
      const evaluate = Ref.update(evaluations, (count) => count + 1).pipe(
        Effect.as(
          ReviewResult.make({
            issues: [],
            summary: "clean"
          })
        )
      )

      yield* cachedReview(store, "cache.json", "a", evaluate)
      yield* cachedReview(store, "cache.json", "a", evaluate)
      yield* cachedReview(store, "cache.json", "b", evaluate)
      yield* Ref.set(files, { "cache.json": "corrupt" })
      yield* cachedReview(store, "cache.json", "b", evaluate)

      assert.strictEqual(yield* Ref.get(evaluations), 3)
      assert.notStrictEqual(reviewFingerprint("ab", "c"), reviewFingerprint("a", "bc"))
    })
  )
})

describe("spec checks and survey", () => {
  it.effect("finds uncovered units and malformed features deterministically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory
        const workspace = yield* makeNodeWorkspace(root)
        yield* workspace.write("legacy/A.cbl", "PARA-A.\n  CALL 'B'.\nPARA-C.\n")
        yield* workspace.write(
          "features/a.feature",
          "Feature: A\nScenario: works\nGiven input\nThen output\n"
        )
        yield* workspace.write("features/b.feature", "Scenario: missing header\nGiven input\n")
        const rules = [
          CoverageRule.make({
            name: "paragraph",
            files: "\\.cbl$",
            unit: "^([A-Z-]+)\\."
          })
        ]
        const result = yield* coverage(workspace, rules, "| PARA-A | covered |")
        const featureResult = yield* features(workspace, "features")

        assert.deepStrictEqual(
          result.issues.map((issue) => issue.title),
          ["uncovered paragraph: PARA-C"]
        )
        assert.strictEqual(featureResult.issues.length, 1)
        assert.match(featureResult.issues[0]?.title ?? "", /b\.feature/)
      })
    )
  )

  it.effect("builds, refines, and renders an auditable estate graph", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory
        const workspace = yield* makeNodeWorkspace(root)
        yield* workspace.write("A.cbl", "PARA-A.\nCALL 'B'.\n")
        yield* workspace.write("B.cbl", "PARA-B.\n")
        yield* workspace.write("C.cbl", "PARA-C.\n")
        const graph = yield* surveyGraph(
          workspace,
          "\\.cbl$",
          [
            CoverageRule.make({
              name: "paragraph",
              files: "\\.cbl$",
              unit: "([A-Z-]+)\\."
            })
          ],
          [
            CoverageRule.make({
              name: "calls",
              files: "\\.cbl$",
              unit: "CALL '([^']+)'"
            })
          ]
        )
        const refined = mergeSurveyEdges(graph, [
          SurveyEdge.make({ from: "B", to: "C", kind: "dynamic" }),
          SurveyEdge.make({ from: "A", to: "B", kind: "duplicate" }),
          SurveyEdge.make({ from: "C", to: "C", kind: "self" })
        ])
        const report = renderSurveyInventory(refined)

        assert.strictEqual(graph.nodes.length, 3)
        assert.deepStrictEqual(
          graph.edges.map((edge) => [edge.from, edge.to, edge.kind]),
          [["A", "B", "calls"]]
        )
        assert.isTrue(
          refined.edges.some(
            (edge) => edge.from === "B" && edge.to === "C" && edge.kind === "llm-dynamic"
          )
        )
        assert.match(report, /Estate inventory/)
        assert.match(report, /3 unit\(s\), 2 edge\(s\)/)
      })
    )
  )
})
