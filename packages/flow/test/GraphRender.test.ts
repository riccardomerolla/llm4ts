import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { neighborhood, probeResults, viewOfPath, wholeView } from "@llm4ts/flow/GraphQuery"
import {
  renderClusterDiagrams,
  renderEntryPaths,
  renderGraphDot,
  renderGraphMermaid,
  renderGraphText
} from "@llm4ts/flow/GraphRender"
import { SurveyEdge, SurveyGraph, SurveyNode, buildCodeGraph } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const { graph } = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { graph, pack }
})

describe("graph rendering", () => {
  it.effect(
    "mermaid groups by file, styles kinds, dots inferred edges, flags unresolved, comments ids",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const withLlm = SurveyGraph.make({
          ...graph,
          edges: [
            ...graph.edges,
            SurveyEdge.make({
              from: "OrphanServlet",
              to: "FEECALC",
              kind: "guess",
              origin: "llm",
              confidence: "inferred",
              mechanism: "llm"
            })
          ]
        })
        const view = neighborhood(
          withLlm,
          ["servlet-mapping:web/WEB-INF/web.xml#invoice", "OrphanServlet"],
          1
        )
        const mermaid = renderGraphMermaid(view, withLlm)
        assert.match(mermaid, /^flowchart LR/)
        assert.match(mermaid, /subgraph f\d+\["web\/WEB-INF\/web.xml"\]/)
        assert.include(mermaid, "classDef servlet-mapping")
        assert.include(mermaid, ":::unresolved") // OrphanServlet is isolated in the scanner graph
        assert.include(mermaid, "-.->|guess|")
        assert.include(mermaid, "-->|servlet-wiring|")
        assert.include(mermaid, "%% servlet-mapping:web/WEB-INF/web.xml#invoice")
        assert.notInclude(mermaid, '"${ctx}') // labels are escaped for mermaid
      })
  )

  it.effect("refuses an oversized mermaid unless forced and degrades to the text list", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 160 }, (_, index) =>
        SurveyNode.make({ path: `src/N${index}.cbl`, name: `N${index}`, lines: 1, units: 0 })
      )
      const graph = SurveyGraph.make({ nodes, edges: [] })
      const capped = renderGraphMermaid(wholeView(graph), graph)
      assert.include(capped, "160 nodes exceed the mermaid cap of 150")
      assert.include(capped, "N159")
      assert.notInclude(capped, "flowchart")
      const forced = renderGraphMermaid(wholeView(graph), graph, { force: true })
      assert.match(forced, /^flowchart LR/)
      const small = renderGraphMermaid(wholeView(graph), graph, { cap: 200 })
      assert.match(small, /^flowchart LR/)
    })
  )

  it.effect("dot and text emit the same view", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      const path = probeResults(graph, pack.graph.probes)[0]!.path!
      const view = viewOfPath(graph, path)
      const dot = renderGraphDot(view, graph)
      assert.match(dot, /^digraph llm4ts \{/)
      assert.include(dot, 'subgraph "cluster_0"')
      assert.include(dot, 'label="jsp-form-action"')
      assert.include(dot, "shape=box")
      const text = renderGraphText(view)
      assert.include(text, "fattura -> InvoiceServlet [jsp-form-action]")
      assert.include(
        text,
        "InvoiceServlet -> esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura [invokes-esb]"
      )
    })
  )

  it.effect("entry paths and cluster diagrams for the inventory", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      const paths = renderEntryPaths(graph)
      assert.include(paths, "fattura → InvoiceServlet (jsp-form-action)")
      assert.include(paths, "ACCTXFR → FEECALC (calls)")
      const clusters = renderClusterDiagrams(graph, pack.consolidate!, [
        "fattura",
        "invoice",
        "InvoiceServlet",
        "ReportServlet",
        "ACCTXFR",
        "FEECALC"
      ])
      assert.include(clusters, "## Cluster")
      assert.include(clusters, "### Cluster 1")
      assert.include(clusters, "```mermaid")
      assert.include(clusters, "InvoiceServlet")
    })
  )
})
