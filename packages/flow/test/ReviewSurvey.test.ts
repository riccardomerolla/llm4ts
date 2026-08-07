import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { cachedReview } from "@llm4ts/flow/ReviewCache"
import { ReviewResult } from "@llm4ts/flow/Review"
import { CoverageRule, coverage, features } from "@llm4ts/flow/SpecChecks"
import {
  SurveyEdge,
  SurveyGraph,
  SurveyNode,
  closureFor,
  mergeSurveyEdges,
  renderSurveyInventory,
  surveyGraph
} from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"

describe("review cache", () => {
  it.effect("reuses matching content and re-evaluates changed/corrupt entries", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const evaluations = yield* Ref.make(0)
      const evaluate = Ref.update(evaluations, (count) => count + 1).pipe(
        Effect.as(
          ReviewResult.make({
            issues: [],
            summary: "clean"
          })
        )
      )

      yield* cachedReview(memory.store, "cache.json", "a", evaluate)
      yield* cachedReview(memory.store, "cache.json", "a", evaluate)
      yield* cachedReview(memory.store, "cache.json", "b", evaluate)
      yield* memory.replace({ "cache.json": "corrupt" })
      yield* cachedReview(memory.store, "cache.json", "b", evaluate)

      assert.strictEqual(yield* Ref.get(evaluations), 3)
    })
  )
})

describe("spec checks and survey", () => {
  it.effect("finds uncovered units and malformed features deterministically", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
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

  it.effect("builds, refines, and renders an auditable estate graph", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
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
})

describe("include closure", () => {
  const node = (name: string): SurveyNode =>
    SurveyNode.make({ path: `src/${name}.cbl`, name, lines: 1, units: 1 })
  const edge = (from: string, to: string): SurveyEdge => SurveyEdge.make({ from, to, kind: "copy" })

  it("walks breadth-first, excluding the program itself", () => {
    const graph = SurveyGraph.make({
      nodes: [node("MAIN"), node("A"), node("B"), node("C")],
      edges: [edge("MAIN", "A"), edge("MAIN", "B"), edge("A", "C")]
    })
    assert.deepStrictEqual(closureFor(graph, "MAIN", 40), ["src/A.cbl", "src/B.cbl", "src/C.cbl"])
  })

  it("terminates on cyclic graphs", () => {
    const graph = SurveyGraph.make({
      nodes: [node("MAIN"), node("A"), node("B")],
      edges: [edge("MAIN", "A"), edge("A", "B"), edge("B", "A"), edge("B", "MAIN")]
    })
    assert.deepStrictEqual(closureFor(graph, "MAIN", 40), ["src/A.cbl", "src/B.cbl"])
  })

  it("bounds the closure to maxFiles and skips dependencies with no inventory path", () => {
    const graph = SurveyGraph.make({
      nodes: [node("MAIN"), node("A"), node("B"), node("C")],
      edges: [edge("MAIN", "A"), edge("MAIN", "GHOST"), edge("A", "B"), edge("B", "C")]
    })
    // GHOST has no node, so it contributes no path; the cap still holds.
    assert.deepStrictEqual(closureFor(graph, "MAIN", 2), ["src/A.cbl", "src/B.cbl"])
    assert.deepStrictEqual(closureFor(graph, "MAIN", 40), ["src/A.cbl", "src/B.cbl", "src/C.cbl"])
  })
})
