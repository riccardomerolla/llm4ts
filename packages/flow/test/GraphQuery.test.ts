import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  closureView,
  graphStats,
  neighborhood,
  pathBetween,
  probeResults,
  resolveNodeRef,
  searchNodes,
  shortestPath
} from "@llm4ts/flow/GraphQuery"
import { buildCodeGraph, nodeId } from "@llm4ts/flow/Survey"
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

describe("graph queries", () => {
  it.effect("searches by id, name, path and attrs, boosts file-mates, filters by kind", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const hits = searchNodes(graph, "salvaFattura")
      // The ESB operation is NAMED SalvaFattura; the mapping only carries it as a URL attr.
      assert.strictEqual(
        nodeId(hits[0]!.node),
        "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura"
      )
      assert.isTrue(
        hits.some((hit) => nodeId(hit.node) === "servlet-mapping:web/WEB-INF/web.xml#invoice")
      )
      assert.isTrue(hits.some((hit) => nodeId(hit.node) === "form:web/fattura.jsp#salvaFattura.do"))
      // The declaration matches nothing itself; co-location with two hits pulls it in last.
      assert.isTrue(
        hits.some((hit) => nodeId(hit.node) === "servlet-decl:web/WEB-INF/web.xml#invoice")
      )
      assert.deepStrictEqual(
        searchNodes(graph, "invoice", { kind: "servlet-decl" }).map((hit) => nodeId(hit.node)),
        ["servlet-decl:web/WEB-INF/web.xml#invoice"]
      )
      assert.strictEqual(searchNodes(graph, "a", { limit: 3 }).length, 3)
    })
  )

  it.effect("walks neighbourhoods and finds shortest paths in either direction", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const one = neighborhood(graph, ["servlet-mapping:web/WEB-INF/web.xml#invoice"], 1)
      assert.deepStrictEqual(one.nodes.map(nodeId).sort(), [
        "ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=",
        "servlet-decl:web/WEB-INF/web.xml#invoice",
        "servlet-mapping:web/WEB-INF/web.xml#invoice"
      ])
      // Raw graph: a page contains its form (no edge), a declaration anchors a file (no edge).
      assert.isUndefined(
        shortestPath(graph, "fattura", "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura")
      )
      const projectedPath = shortestPath(graph, "fattura", "InvoiceServlet", 8, { projected: true })
      assert.deepStrictEqual(
        projectedPath?.map((edge) => edge.kind),
        ["jsp-form-action"]
      )
      const both = pathBetween(graph, "InvoiceServlet", "fattura", 8, { projected: true })
      assert.isUndefined(both.forward)
      assert.strictEqual(both.backward?.length, 1)
    })
  )

  it.effect("resolves node references and evaluates probes on the union graph", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      assert.strictEqual(nodeId(resolveNodeRef(graph, "fattura")!), "fattura")
      assert.strictEqual(
        nodeId(resolveNodeRef(graph, "esb-call:SalvaFattura")!),
        "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura"
      )
      assert.strictEqual(
        nodeId(resolveNodeRef(graph, "servlet-mapping:web/WEB-INF/web.xml#invoice~2")!),
        "servlet-mapping:web/WEB-INF/web.xml#invoice~2"
      )
      assert.isUndefined(resolveNodeRef(graph, "ghost"))
      const results = probeResults(graph, pack.graph.probes)
      assert.deepStrictEqual(
        results.map((result) => `${result.probe.name}:${result.status}`),
        ["save-invoice:ok", "monthly-report:ok", "orphan:broken"]
      )
      assert.deepStrictEqual(
        results[0]?.path?.map((edge) => edge.kind),
        ["jsp-form-action", "invokes-esb"]
      )
    })
  )

  it.effect("closure view and stats", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const view = closureView(graph, "fattura", 10)
      assert.deepStrictEqual(view.nodes.map(nodeId).sort(), ["InvoiceServlet", "fattura", "header"])
      const stats = graphStats(graph)
      assert.strictEqual(stats.nodes["cobol-paragraph"], 5)
      assert.strictEqual(stats.edges["servlet-wiring"], 3)
      assert.strictEqual(stats.mechanism["join:url"], 3)
      assert.strictEqual(stats.origin.scanner, stats.total.edges)
      assert.strictEqual(stats.unresolved["edge-target"], 2)
    })
  )
})
