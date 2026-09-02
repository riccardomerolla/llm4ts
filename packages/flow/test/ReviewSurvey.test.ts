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
  surveyGraph,
  surveyRefinePrompt,
  surveyTriagePrompt
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

describe("web estate survey", () => {
  const jspRules = [
    CoverageRule.make({
      name: "jsp-include",
      files: "\\.jsp$",
      unit: '<jsp:include page="([^"]+)"'
    }),
    CoverageRule.make({
      name: "servlet-class",
      files: "web\\.xml$",
      unit: "<servlet-class>[a-z.]*\\.([A-Za-z0-9]+)</servlet-class>"
    })
  ]

  it.effect("resolves path-shaped references onto units so fragments keep their callers", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "src/main/webapp/login.jsp",
        '<jsp:include page="header.jsp" />\n<jsp:include page="/WEB-INF/fragments/footer.jsp" />\n'
      )
      yield* workspace.write("src/main/webapp/header.jsp", "<h1>Bank</h1>\n")
      yield* workspace.write("src/main/webapp/WEB-INF/fragments/footer.jsp", "<p/>\n")
      yield* workspace.write(
        "src/main/webapp/WEB-INF/web.xml",
        "<servlet-class>com.bank.web.LoginServlet</servlet-class>\n" +
          "<servlet-class>com.bank.web.GhostServlet</servlet-class>\n"
      )
      yield* workspace.write(
        "src/main/java/com/bank/web/LoginServlet.java",
        "class LoginServlet {}\n"
      )
      // Sources the estate does not own: the copy under target/ is pruned by
      // the default limits, the vendored one by the exclude regex.
      yield* workspace.write("target/webapp/login.jsp", '<jsp:include page="header.jsp" />\n')
      yield* workspace.write("vendor/theme/header.jsp", "<h1>Theme</h1>\n")

      const graph = yield* surveyGraph(workspace, "\\.(jsp|java|xml)$", [], jspRules, {
        exclude: "^vendor/"
      })

      assert.deepStrictEqual(graph.nodes.map((node) => node.name).sort(), [
        "LoginServlet",
        "footer",
        "header",
        "login",
        "web"
      ])
      assert.deepStrictEqual(
        graph.edges.map((edge) => `${edge.from}->${edge.to} (${edge.kind})`).sort(),
        [
          "login->footer (jsp-include)",
          "login->header (jsp-include)",
          "web->GhostServlet (servlet-class)",
          "web->LoginServlet (servlet-class)"
        ]
      )
      // The bug this guards: header/footer used to carry zero incoming edges
      // and be flagged as retire candidates in the inventory.
      assert.strictEqual(graph.incoming("header").length, 1)
      assert.strictEqual(graph.incoming("footer").length, 1)
      const inventory = renderSurveyInventory(graph)
      assert.notMatch(inventory, /\| header \|.*retire candidate/)
      assert.match(
        inventory,
        /\| header \| src\/main\/webapp\/header\.jsp \| \d+ \| 0 \| 1 \| 0 \|/
      )
    })
  )

  it("composes the reasoning prompts from the pack's rules and guidance, never a fixed stack", () => {
    const graph = SurveyGraph.make({
      nodes: [SurveyNode.make({ path: "a/login.jsp", name: "login", lines: 1, units: 0 })],
      edges: []
    })
    const cobol = {
      rules: [CoverageRule.make({ name: "calls", files: "", unit: "" })],
      guidance: "Dynamic CALLs (CALL WS-PROGRAM) and JCL EXEC PGM=&PGM hide targets."
    }
    const jsp = {
      rules: jspRules,
      guidance: "web.xml servlet-mapping and <jsp:include> wire pages."
    }
    const neutral = {
      rules: [CoverageRule.make({ name: "references", files: "", unit: "" })],
      guidance: undefined
    }

    const cobolRefine = surveyRefinePrompt(graph, cobol)
    assert.include(cobolRefine, "survey rules (calls)")
    assert.include(cobolRefine, "EXEC PGM=&PGM")
    assert.include(cobolRefine, "Units: login")
    assert.include(cobolRefine, '"evidence"')

    const jspRefine = surveyRefinePrompt(graph, jsp)
    assert.include(jspRefine, "survey rules (jsp-include, servlet-class)")
    assert.include(jspRefine, "servlet-mapping")
    assert.notInclude(jspRefine, "COBOL")
    assert.notInclude(jspRefine, "JCL")
    assert.notInclude(jspRefine, "COPY")

    const jspTriage = surveyTriagePrompt(graph, "# Estate inventory", jsp)
    assert.include(jspTriage, "jsp-include, servlet-class")
    assert.include(jspTriage, "<jsp:include>")
    assert.include(jspTriage, '"triage"')
    assert.include(jspTriage, "# Estate inventory")
    assert.notInclude(jspTriage, "JCL")

    // Both prompts keep working, stack-neutrally, for a pack with no sidecars.
    const neutralRefine = surveyRefinePrompt(graph, neutral)
    const neutralTriage = surveyTriagePrompt(graph, "", neutral)
    for (const prompt of [neutralRefine, neutralTriage]) {
      assert.notInclude(prompt, "COBOL")
      assert.notInclude(prompt, "JCL")
      assert.notInclude(prompt, "servlet")
    }
    assert.include(neutralRefine, "refining the dependency graph")
    assert.include(neutralTriage, "triaging a legacy estate")
  })
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
