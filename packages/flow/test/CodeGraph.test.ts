import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  SurveyEdge,
  SurveyGraph,
  SurveyNode,
  closureFor,
  graphFromJson,
  nodeId,
  nodeKind,
  projectToFiles
} from "@llm4ts/flow/Survey"

const fileNode = (name: string, path = `src/${name}.jsp`): SurveyNode =>
  SurveyNode.make({ path, name, lines: 10, units: 1 })

describe("code graph schema", () => {
  it.effect("decodes a v1 graph.json and projects it to itself", () =>
    Effect.gen(function* () {
      const v1 = JSON.stringify({
        nodes: [
          { path: "src/A.cbl", name: "A", lines: 3, units: 1 },
          { path: "src/B.cbl", name: "B", lines: 3, units: 1 }
        ],
        edges: [{ from: "A", to: "B", kind: "calls" }]
      })
      const graph = yield* graphFromJson(v1)
      assert.deepStrictEqual(graph.nodes.map(nodeId), ["A", "B"])
      assert.deepStrictEqual(graph.nodes.map(nodeKind), ["file", "file"])
      assert.deepStrictEqual(graph.unresolved, [])
      assert.deepStrictEqual(graph.fills, [])
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`),
        ["A->B:calls"]
      )
      assert.deepStrictEqual(closureFor(graph, "A", 10), ["src/B.cbl"])
    })
  )

  it("still constructs with the four original node fields", () => {
    const graph = SurveyGraph.make({
      nodes: [fileNode("a"), fileNode("b")],
      edges: [SurveyEdge.make({ from: "a", to: "b", kind: "jsp-include" })]
    })
    assert.strictEqual(graph.unresolved.length, 0)
    assert.strictEqual(nodeId(graph.nodes[0]!), "a")
  })

  it("contracts descriptor nodes and folds anchored nodes onto their unit", () => {
    const page = fileNode("fattura", "web/fattura.jsp")
    const servlet = fileNode("InvoiceServlet", "src/InvoiceServlet.java")
    const web = fileNode("web", "web/WEB-INF/web.xml")
    const ajax = SurveyNode.make({
      path: "web/fattura.jsp",
      name: "/salvaFattura",
      lines: 10,
      units: 0,
      id: "ajax-call:web/fattura.jsp#/salvaFattura",
      kind: "ajax-call",
      attrs: { url: "/salvaFattura" }
    })
    const mapping = SurveyNode.make({
      path: "web/WEB-INF/web.xml",
      name: "invoice",
      lines: 10,
      units: 0,
      id: "servlet-mapping:web/WEB-INF/web.xml#invoice",
      kind: "servlet-mapping",
      attrs: { url: "/salvaFattura" },
      descriptor: true
    })
    const decl = SurveyNode.make({
      path: "web/WEB-INF/web.xml",
      name: "invoice",
      lines: 10,
      units: 0,
      id: "servlet-decl:web/WEB-INF/web.xml#invoice",
      kind: "servlet-decl",
      attrs: { class: "InvoiceServlet" },
      descriptor: true,
      anchor: "class"
    })
    const graph = SurveyGraph.make({
      nodes: [page, servlet, web, ajax, mapping, decl],
      edges: [
        SurveyEdge.make({
          from: nodeId(ajax),
          to: nodeId(mapping),
          kind: "jsp-ajax-target",
          mechanism: "join:url"
        }),
        SurveyEdge.make({
          from: nodeId(mapping),
          to: nodeId(decl),
          kind: "servlet-wiring",
          mechanism: "join:exact"
        })
      ]
    })
    const projected = projectToFiles(graph)
    assert.deepStrictEqual(projected.nodes.map(nodeId).sort(), ["InvoiceServlet", "fattura", "web"])
    assert.deepStrictEqual(
      projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}:${edge.mechanism}`),
      ["fattura->InvoiceServlet:jsp-ajax-target:contraction"]
    )
    assert.deepStrictEqual(closureFor(graph, "fattura", 10), ["src/InvoiceServlet.java"])
  })

  it("encodes new fields and round-trips through the schema", () => {
    const edge = SurveyEdge.make({
      from: "a",
      to: "b",
      kind: "k",
      origin: "llm",
      confidence: "inferred",
      mechanism: "llm",
      evidence: { file: "src/a.js", line: 4, snippet: "x" }
    })
    const decoded = Schema.decodeUnknownSync(SurveyEdge)(JSON.parse(JSON.stringify(edge)))
    assert.strictEqual(decoded.origin, "llm")
    assert.strictEqual(decoded.evidence?.line, 4)
  })
})
