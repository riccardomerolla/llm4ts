import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { makeGraphProgram, type GraphDependencies } from "@llm4ts/runner/Graph"

/**
 * A web-only slice of the flow package's legacy-mini fixture (a project
 * reference cannot import another project's test support): a page, a jQuery
 * file, a web.xml with exact, prefix and extension mappings plus an orphan
 * declaration, servlets and an ESB wrapper.
 */
const estateFiles: Readonly<Record<string, string>> = {
  "web/fattura.jsp": [
    '<jsp:include page="/web/header.jsp"/>',
    '<form action="salvaFattura.do" method="post"><input name="importo"/></form>',
    ""
  ].join("\n"),
  "web/header.jsp": '<div class="header">Banca</div>\n',
  "web/js/invoice.js": [
    "$.ajax({ url: '${ctx}/salvaFattura?id=' + id, type: 'POST' });",
    "$.get('/api/report/monthly');",
    ""
  ].join("\n"),
  "web/WEB-INF/web.xml": [
    "<web-app>",
    "  <servlet><servlet-name>invoice</servlet-name><servlet-class>com.legacy.InvoiceServlet</servlet-class></servlet>",
    "  <servlet><servlet-name>report</servlet-name><servlet-class>com.legacy.ReportServlet</servlet-class></servlet>",
    "  <servlet><servlet-name>orphan</servlet-name><servlet-class>com.legacy.OrphanServlet</servlet-class></servlet>",
    "  <servlet-mapping><servlet-name>invoice</servlet-name><url-pattern>/salvaFattura</url-pattern></servlet-mapping>",
    "  <servlet-mapping><servlet-name>report</servlet-name><url-pattern>/api/*</url-pattern></servlet-mapping>",
    "  <servlet-mapping><servlet-name>invoice</servlet-name><url-pattern>*.do</url-pattern></servlet-mapping>",
    "</web-app>",
    ""
  ].join("\n"),
  "src/com/legacy/InvoiceServlet.java": [
    "package com.legacy;",
    "public class InvoiceServlet extends HttpServlet {",
    '  void doPost() { new EsbInvoiceService().call("SalvaFattura", null); }',
    "}",
    ""
  ].join("\n"),
  "src/com/legacy/ReportServlet.java": "package com.legacy;\npublic class ReportServlet {}\n",
  "src/com/legacy/OrphanServlet.java": "package com.legacy;\npublic class OrphanServlet {}\n",
  "src/com/legacy/EsbInvoiceService.java":
    "package com.legacy;\npublic class EsbInvoiceService {}\n"
}

const packManifest = `# Pack: web-mini

source: jsp
sources: .*\\.(jsp|js|java|xml)

## Survey: jsp-include

files: .*\\.jsp
unit: <jsp:include page="([^"]+)"

## Node: ajax-call

files: .*\\.(js|jsp)
pattern: (?:url:\\s*|\\$\\.(?:get|post)\\(\\s*)['"](?<name>[^'"]+)['"]
attrs: url=name

## Node: form

files: .*\\.jsp
pattern: action="(?<name>[^"]+)"
attrs: url=name

## Node: servlet-mapping

files: .*web\\.xml
pattern: <servlet-mapping>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>\\s*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: servlet-decl

files: .*web\\.xml
pattern: <servlet>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>(?:(?!</servlet>)[\\s\\S])*?<servlet-class>(?:[a-z0-9_]+\\.)*(?<class>[A-Za-z0-9_]+)</servlet-class>
descriptor: yes
anchor: class

## Node: esb-call

files: .*\\.java
pattern: new Esb(?<service>[A-Za-z0-9]+)\\(\\)\\.call\\("(?<name>[A-Za-z0-9]+)"

## Edge: invokes-esb

files: .*\\.java
pattern: \\.call\\("(?<to>[A-Za-z0-9]+)"
to: esb-call

## Join: jsp-ajax-target

from: ajax-call.url
to: servlet-mapping.url
match: url

## Join: jsp-form-action

from: form.url
to: servlet-mapping.url
match: url

## Join: servlet-wiring

from: servlet-mapping.name
to: servlet-decl.name
scope: file

## Probe: save-invoice

from: fattura
to: esb-call:SalvaFattura

## Probe: orphan

from: fattura
to: OrphanServlet
`

const deps = Effect.gen(function* () {
  const estate = yield* makeMemoryWorkspace({ root: "/estate" })
  yield* Effect.forEach(Object.entries(estateFiles), ([path, text]) => estate.write(path, text))
  const packs = yield* makeMemoryWorkspace({ root: "/packs" })
  yield* packs.write("pack/pack.md", packManifest)
  const pack = yield* loadPack(packs, "pack")
  const memory = yield* makeMemoryPlainFileStore()
  const dependencies: GraphDependencies = {
    files: memory.store,
    workspace: () => Effect.succeed(estate),
    openPack: () => Effect.succeed(pack)
  }
  return { dependencies, files: memory.store }
})

describe("llm4ts graph", () => {
  it.effect("build writes the cache and reports stats; later commands read it", () =>
    Effect.gen(function* () {
      const { dependencies, files } = yield* deps
      const built = yield* makeGraphProgram({ _tag: "build", repo: "/estate" }, dependencies)
      assert.include(built, "nodes:")
      assert.include(built, "unresolved:")
      assert.isDefined(yield* files.read("/estate/.llm4ts/graph/web-mini.json"))

      const stats = yield* makeGraphProgram(
        { _tag: "stats", repo: "/estate", format: "json" },
        dependencies
      )
      assert.strictEqual(JSON.parse(stats).edges["servlet-wiring"], 3)

      const query = yield* makeGraphProgram(
        {
          _tag: "query",
          repo: "/estate",
          text: "salvaFattura",
          hops: 1,
          format: "text",
          all: false,
          force: false
        },
        dependencies
      )
      assert.include(query, "servlet-mapping:web/WEB-INF/web.xml#invoice")
      assert.include(query, "servlet-decl:web/WEB-INF/web.xml#invoice")

      const path = yield* makeGraphProgram(
        {
          _tag: "path",
          repo: "/estate",
          from: "fattura",
          to: "esb-call:SalvaFattura",
          max: 8,
          format: "mermaid",
          force: false
        },
        dependencies
      )
      assert.match(path, /^flowchart LR/)
      assert.include(path, "invokes-esb")

      const closure = yield* makeGraphProgram(
        {
          _tag: "closure",
          repo: "/estate",
          program: "fattura",
          max: 10,
          format: "dot",
          force: false
        },
        dependencies
      )
      assert.match(closure, /^digraph llm4ts/)

      const probes = yield* makeGraphProgram(
        { _tag: "probe", repo: "/estate", format: "text" },
        dependencies
      )
      assert.include(probes, "save-invoice: ok")
      assert.include(probes, "orphan: broken")
    })
  )

  it.effect("an unknown node reference is a readable failure, not a crash", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* deps
      const error = yield* Effect.flip(
        makeGraphProgram(
          {
            _tag: "path",
            repo: "/estate",
            from: "ghost",
            to: "fattura",
            max: 8,
            format: "text",
            force: false
          },
          dependencies
        )
      )
      assert.include(String(error), "ghost")
    })
  )
})
