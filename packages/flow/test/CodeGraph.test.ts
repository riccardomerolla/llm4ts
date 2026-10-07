import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  Fill,
  SurveyEdge,
  SurveyGraph,
  SurveyNode,
  appOf,
  appRoots,
  applyFillsAndJoins,
  buildCodeGraph,
  closureFor,
  graphFromJson,
  nodeAttrs,
  nodeId,
  nodeKind,
  nodeLineEnd,
  nodeLineStart,
  projectToFiles,
  surveyGraph
} from "@llm4ts/flow/Survey"
import { CoverageRule } from "@llm4ts/flow/SpecChecks"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

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

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const build = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { workspace, pack, build, graph: build.graph }
})

describe("scanner pass", () => {
  it.effect("creates file nodes and sub-file nodes with stable ids, attrs and spans", () =>
    Effect.gen(function* () {
      const { graph, build } = yield* built
      const ids = graph.nodes.map(nodeId)
      assert.include(ids, "fattura")
      assert.include(ids, "ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=")
      assert.include(ids, "ajax-call:web/js/invoice.js#/api/report/monthly")
      assert.include(ids, "ajax-dynamic:web/js/invoice.js#base + '/dynamic'")
      assert.include(ids, "form:web/fattura.jsp#salvaFattura.do")
      assert.include(ids, "servlet-mapping:web/WEB-INF/web.xml#invoice")
      assert.include(ids, "servlet-mapping:web/WEB-INF/web.xml#invoice~2")
      assert.include(ids, "servlet-decl:web/WEB-INF/web.xml#orphan")
      assert.include(ids, "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura")
      assert.include(ids, "cobol-section:cobol/ACCTXFR.cbl#MAIN-LOGIC")
      assert.include(ids, "cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN")
      const decl = graph.node("servlet-decl:web/WEB-INF/web.xml#invoice")!
      assert.deepStrictEqual(nodeAttrs(decl), { class: "InvoiceServlet" })
      assert.strictEqual(decl.descriptor, true)
      assert.strictEqual(decl.anchor, "class")
      const esb = graph.node("esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura")!
      assert.deepStrictEqual(nodeAttrs(esb), { service: "InvoiceService" })
      const main = graph.node("cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN")!
      assert.strictEqual(nodeLineStart(main), 5)
      assert.strictEqual(nodeLineEnd(main), 7)
      const file = graph.node("ACCTXFR")!
      assert.strictEqual(file.units, 4)
      assert.strictEqual(Object.keys(build.files).length, 10)
    })
  )

  it.effect(
    "captures edges from the enclosing node, resolves targets same-file first, expands THRU, keeps file literals",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const captured = graph.edges
          .filter((edge) => edge.mechanism === "capture")
          .map((edge) => `${edge.kind}:${edge.from}->${edge.to}`)
          .sort()
        assert.deepStrictEqual(captured, [
          "calls:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->FEECALC",
          "calls:cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST->AUDITLOG",
          "goes-to:cobol-paragraph:cobol/ACCTXFR.cbl#0250-CHECK->cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
          "invokes-esb:InvoiceServlet->esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura",
          "jsp-include:fattura->header",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0200-VALIDATE",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0250-CHECK",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST"
        ])
        const performs = graph.edges.find((edge) => edge.kind === "performs")!
        assert.strictEqual(performs.rule, "performs")
        assert.strictEqual(performs.origin, "scanner")
        assert.strictEqual(performs.confidence, "exact")
        assert.strictEqual(performs.evidence?.line, 6)
        assert.include(performs.evidence?.snippet, "PERFORM 0200-VALIDATE THRU 0300-POST")
        const missing = graph.unresolved.filter((item) => item.reason === "edge-target")
        assert.deepStrictEqual(missing.map((item) => `${item.rule}:${item.reference}`).sort(), [
          "calls:AUDITLOG",
          "performs:9999-MISSING"
        ])
      })
  )

  it.effect("surveyGraph on Survey-only rules is unchanged", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "legacy/A.cbl",
        "       0100-A.\n           CALL 'B'.\n           COPY CPY1.\n"
      )
      yield* workspace.write("legacy/B.cbl", "       0100-B.\n")
      const graph = yield* surveyGraph(
        workspace,
        "\\.cbl$",
        [],
        [
          CoverageRule.make({ name: "calls", files: "\\.cbl$", unit: "CALL '([A-Z0-9]+)'" }),
          CoverageRule.make({ name: "copies", files: "\\.cbl$", unit: "COPY +([A-Z0-9]+)" })
        ]
      )
      assert.deepStrictEqual(
        graph.nodes.map((node) => node.name),
        ["A", "B"]
      )
      assert.deepStrictEqual(
        graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`),
        ["A->B:calls", "A->CPY1:copies"]
      )
    })
  )
})

describe("joins", () => {
  it.effect(
    "joins ajax, form and mapping nodes in servlet-spec order within the app, and wires mappings to declarations",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const joins = graph.edges
          .filter((edge) => edge.mechanism?.startsWith("join:"))
          .map((edge) => `${edge.kind}:${edge.from}->${edge.to}[${edge.join ?? "-"}]`)
          .sort()
        assert.deepStrictEqual(joins, [
          "jsp-ajax-target:ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=->servlet-mapping:web/WEB-INF/web.xml#invoice[exact]",
          "jsp-ajax-target:ajax-call:web/js/invoice.js#/api/report/monthly->servlet-mapping:web/WEB-INF/web.xml#report[prefix]",
          "jsp-form-action:form:web/fattura.jsp#salvaFattura.do->servlet-mapping:web/WEB-INF/web.xml#invoice~2[extension]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#invoice->servlet-decl:web/WEB-INF/web.xml#invoice[exact]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#invoice~2->servlet-decl:web/WEB-INF/web.xml#invoice[exact]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#report->servlet-decl:web/WEB-INF/web.xml#report[exact]"
        ])
        const wiring = graph.edges.find((edge) => edge.kind === "servlet-wiring")!
        assert.strictEqual(wiring.rule, "servlet-wiring")
        assert.strictEqual(wiring.origin, "scanner")
      })
  )

  it.effect("lists what the scanner could not resolve, by reason", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const summary = graph.unresolved
        .map((item) => `${item.reason}:${item.rule}:${item.node}`)
        .sort()
      assert.deepStrictEqual(summary, [
        "edge-target:calls:cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
        "edge-target:performs:cobol-paragraph:cobol/ACCTXFR.cbl#0200-VALIDATE",
        "isolated:file:EsbInvoiceService",
        "isolated:file:OrphanServlet",
        "join-to:servlet-wiring:servlet-decl:web/WEB-INF/web.xml#orphan",
        "missing-attr:jsp-ajax-target:ajax-dynamic:web/js/invoice.js#base + '/dynamic'"
      ])
    })
  )

  it.effect("projects through descriptors so the file graph has page → servlet edges", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
        [
          "ACCTXFR->AUDITLOG:calls",
          "ACCTXFR->FEECALC:calls",
          "fattura->InvoiceServlet:jsp-form-action",
          "fattura->header:jsp-include",
          "invoice->InvoiceServlet:jsp-ajax-target",
          "invoice->ReportServlet:jsp-ajax-target"
        ]
      )
      assert.deepStrictEqual([...closureFor(graph, "fattura", 10)].sort(), [
        "src/com/legacy/InvoiceServlet.java",
        "web/header.jsp"
      ])
    })
  )

  it.effect("re-derives joins after a fill and scopes url joins per app", () =>
    Effect.gen(function* () {
      const { graph, pack, build } = yield* built
      const filled = applyFillsAndJoins(
        graph,
        [
          Fill.make({
            node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
            key: "url",
            value: "/api/dynamic",
            evidence: { file: "web/js/invoice.js", line: 6, snippet: "$.post(base + '/dynamic');" }
          })
        ],
        pack.graph,
        Object.keys(build.files)
      )
      const edge = filled.edges.find(
        (e) => e.from === "ajax-dynamic:web/js/invoice.js#base + '/dynamic'"
      )!
      assert.strictEqual(edge.to, "servlet-mapping:web/WEB-INF/web.xml#report")
      assert.strictEqual(edge.origin, "llm")
      assert.strictEqual(edge.confidence, "inferred")
      assert.isFalse(filled.unresolved.some((item) => item.reason === "missing-attr"))
      assert.deepStrictEqual(
        appRoots(["web/WEB-INF/web.xml", "web/js/a.js", "other/WEB-INF/web.xml", "lib/x.java"]),
        ["other", "web"]
      )
      assert.strictEqual(appOf("web/js/a.js", ["other", "web"]), "web")
      assert.strictEqual(appOf("lib/x.java", ["other", "web"]), "")
    })
  )

  it.effect(
    "a second url-pattern in one mapping is not captured and leaves the ajax side unresolved, never mis-joined",
    () =>
      Effect.gen(function* () {
        const workspace = yield* makeMemoryWorkspace()
        yield* writeLegacyMini(workspace)
        yield* workspace.write(
          "web/WEB-INF/web.xml",
          [
            "<web-app>",
            "  <servlet><servlet-name>r</servlet-name><servlet-class>com.legacy.ReportServlet</servlet-class></servlet>",
            "  <servlet-mapping>",
            "    <servlet-name>r</servlet-name>",
            "    <url-pattern>/first</url-pattern>",
            "    <url-pattern>/api/*</url-pattern>",
            "  </servlet-mapping>",
            "</web-app>",
            ""
          ].join("\n")
        )
        const pack = yield* loadLegacyMiniPack(workspace)
        const { graph } = yield* buildCodeGraph(workspace, {
          sources: pack.sources ?? ".*",
          coverage: pack.coverage,
          rules: pack.graph
        })
        assert.isUndefined(
          graph.edges.find(
            (edge) =>
              edge.from === "ajax-call:web/js/invoice.js#/api/report/monthly" &&
              edge.kind === "jsp-ajax-target"
          )
        )
        assert.isTrue(
          graph.unresolved.some(
            (item) =>
              item.reason === "join-from" &&
              item.node === "ajax-call:web/js/invoice.js#/api/report/monthly"
          )
        )
      })
  )
})

describe("survey rules keep positional captures (pre-0030 packs)", () => {
  it.effect(
    "a Survey unit regex with a non-capturing or escaped paren before its group still yields edges",
    () =>
      Effect.gen(function* () {
        const workspace = yield* makeMemoryWorkspace()
        yield* workspace.write(
          "legacy/A.cbl",
          [
            "       0100-A.",
            "           LINK 'B'.",
            "           EXEC CICS LINK PROGRAM('C') END-EXEC.",
            "           COPY CPY1.",
            ""
          ].join("\n")
        )
        yield* workspace.write("legacy/B.cbl", "       0100-B.\n")
        yield* workspace.write("legacy/C.cbl", "       0100-C.\n")
        const graph = yield* surveyGraph(
          workspace,
          "\\.cbl$",
          [],
          [
            CoverageRule.make({
              name: "calls",
              files: "\\.cbl$",
              unit: "(?:CALL|LINK) +'([A-Z0-9]+)'"
            }),
            CoverageRule.make({
              name: "cics-link",
              files: "\\.cbl$",
              unit: "EXEC CICS LINK PROGRAM\\('([A-Z0-9]+)'\\)"
            }),
            // No capture group at all: the whole match is the target, as before.
            CoverageRule.make({ name: "copies", files: "\\.cbl$", unit: "CPY[0-9]+" })
          ]
        )
        assert.deepStrictEqual(
          graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
          ["A->B:calls", "A->C:cics-link", "A->CPY1:copies"]
        )
      })
  )
})
