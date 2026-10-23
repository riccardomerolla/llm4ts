import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { buildCodeGraph, nodeAttrs, nodeId, projectToFiles } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const kitsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The shipped j2ee pack's graph rules against the markup real estates carry:
 * IDE-generated `<servlet>` blocks with description and display-name before
 * the name, Struts `<html:form>`, upper-case `<FORM ACTION>`, single-quoted
 * actions, and ajax `url` keys written with spaces or quotes.
 */
describe("j2ee-nextjs-spa graph rules on representative markup", () => {
  it.effect("declarations, forms and ajax calls are captured and joined to their servlets", () =>
    Effect.gen(function* () {
      const kits = yield* makeNodeWorkspace(kitsRoot)
      const pack = yield* loadPack(kits, "j2ee-nextjs/packs/j2ee-nextjs-spa")
      const estate = yield* makeMemoryWorkspace()
      yield* estate.write(
        "web/WEB-INF/web.xml",
        [
          "<web-app>",
          "  <servlet>",
          "    <description>Login</description>",
          "    <display-name>login</display-name>",
          "    <servlet-name>login</servlet-name>",
          "    <servlet-class>com.bank.web.LoginServlet</servlet-class>",
          "    <load-on-startup>1</load-on-startup>",
          "  </servlet>",
          "  <servlet><servlet-name>report</servlet-name><servlet-class>com.bank.web.ReportServlet</servlet-class></servlet>",
          "  <servlet-mapping><servlet-name>login</servlet-name><url-pattern>/login</url-pattern></servlet-mapping>",
          "  <servlet-mapping><servlet-name>login</servlet-name><url-pattern>*.do</url-pattern></servlet-mapping>",
          "  <servlet-mapping><servlet-name>report</servlet-name><url-pattern>/api/*</url-pattern></servlet-mapping>",
          "</web-app>",
          ""
        ].join("\n")
      )
      yield* estate.write(
        "web/login.jsp",
        [
          '<html:form action="/login" method="post"><html:text property="user"/></html:form>',
          "<FORM ACTION='save.do' METHOD=POST></FORM>",
          "<script>",
          "  $.ajax({ url : '/api/report/monthly' });",
          '  $.ajax({ "url": "/login" });',
          "</script>",
          ""
        ].join("\n")
      )
      yield* estate.write(
        "src/com/bank/web/LoginServlet.java",
        "package com.bank.web;\npublic class LoginServlet {}\n"
      )
      yield* estate.write(
        "src/com/bank/web/ReportServlet.java",
        "package com.bank.web;\npublic class ReportServlet {}\n"
      )
      const { graph } = yield* buildCodeGraph(estate, {
        sources: pack.sources ?? ".*",
        coverage: pack.coverage,
        rules: pack.graph
      })
      const decls = graph.nodes.filter((node) => node.kind === "servlet-decl")
      assert.deepStrictEqual(decls.map((node) => `${node.name}=${nodeAttrs(node).class}`).sort(), [
        "login=LoginServlet",
        "report=ReportServlet"
      ])
      assert.deepStrictEqual(
        graph.nodes
          .filter((node) => node.kind === "form")
          .map((node) => nodeAttrs(node).url)
          .sort(),
        ["/login", "save.do"]
      )
      assert.deepStrictEqual(
        graph.nodes
          .filter((node) => node.kind === "ajax-call")
          .map((node) => nodeAttrs(node).url)
          .sort(),
        ["/api/report/monthly", "/login"]
      )
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
        [
          "login->LoginServlet:jsp-ajax-target",
          "login->LoginServlet:jsp-form-action",
          "login->ReportServlet:jsp-ajax-target",
          "web->LoginServlet:servlet-class",
          "web->ReportServlet:servlet-class"
        ]
      )
      assert.isFalse(
        graph.unresolved.some((item) => item.reason === "join-to" || item.reason === "join-from"),
        graph.unresolved
          .map((item) => `${item.reason}:${nodeId(graph.node(item.node)!)}`)
          .join(", ")
      )
    })
  )
})

describe("j2ee-nextjs-spa Java and script coverage", () => {
  it.effect(
    "Java classes link by import, instantiation and static call; .js files are sources",
    () =>
      Effect.gen(function* () {
        const kits = yield* makeNodeWorkspace(kitsRoot)
        const pack = yield* loadPack(kits, "j2ee-nextjs/packs/j2ee-nextjs-spa")
        const estate = yield* makeMemoryWorkspace()
        yield* estate.write(
          "src/com/bank/web/LoginServlet.java",
          [
            "package com.bank.web;",
            "import java.util.ArrayList;",
            "import com.bank.svc.InvoiceService;",
            "public class LoginServlet extends HttpServlet {",
            '  void doPost() { new InvoiceService().save(new ArrayList<String>()); EsbGateway.call("Op"); }',
            "}",
            ""
          ].join("\n")
        )
        yield* estate.write(
          "src/com/bank/svc/InvoiceService.java",
          "package com.bank.svc;\npublic class InvoiceService {}\n"
        )
        yield* estate.write(
          "src/com/bank/esb/EsbGateway.java",
          "package com.bank.esb;\npublic class EsbGateway {}\n"
        )
        yield* estate.write(
          "src/com/bank/dto/Dto.java",
          "package com.bank.dto;\npublic class Dto {}\n"
        )
        yield* estate.write("web/js/app.js", "$.ajax({ url: '/api/x' });\n")
        const { graph } = yield* buildCodeGraph(estate, {
          sources: pack.sources ?? ".*",
          coverage: pack.coverage,
          rules: pack.graph
        })
        assert.deepStrictEqual(
          graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
          [
            "LoginServlet->EsbGateway:java-static-call",
            "LoginServlet->InvoiceService:java-import",
            "LoginServlet->InvoiceService:java-new"
          ]
        )
        assert.isTrue(
          graph.nodes.some((node) => node.kind === "ajax-call" && node.path === "web/js/app.js")
        )
        // The JDK is never a hole, and a DTO nothing references is a real isolated finding.
        assert.isFalse(graph.unresolved.some((item) => item.reason === "edge-target"))
        assert.deepStrictEqual(
          graph.unresolved.filter((item) => item.reason === "isolated").map((item) => item.node),
          ["Dto"]
        )
      })
  )
})

describe("j2ee-nextjs-spa on a classic web.xml (jsp-file servlets, forms posting to pages)", () => {
  it.effect("URL → jsp-file servlets and direct .jsp actions both reach the page", () =>
    Effect.gen(function* () {
      const kits = yield* makeNodeWorkspace(kitsRoot)
      const pack = yield* loadPack(kits, "j2ee-nextjs/packs/j2ee-nextjs-spa")
      const estate = yield* makeMemoryWorkspace()
      yield* estate.write(
        "web/WEB-INF/web.xml",
        [
          "<web-app>",
          "  <servlet>",
          "    <servlet-name>salva</servlet-name>",
          "    <jsp-file>/pages/salvaFattura.jsp</jsp-file>",
          "  </servlet>",
          "  <servlet-mapping><servlet-name>salva</servlet-name><url-pattern>/salva</url-pattern></servlet-mapping>",
          "</web-app>",
          ""
        ].join("\n")
      )
      yield* estate.write(
        "web/pages/fattura.jsp",
        [
          '<form action="/salva" method="post"></form>',
          "<form action='dettaglio.jsp'></form>",
          "<script>$.ajax({ url: 'stampa.jsp?id=1' });</script>",
          ""
        ].join("\n")
      )
      yield* estate.write("web/pages/salvaFattura.jsp", "<p>saved</p>\n")
      yield* estate.write("web/pages/dettaglio.jsp", "<p>detail</p>\n")
      yield* estate.write("web/pages/stampa.jsp", "<p>print</p>\n")
      const { graph } = yield* buildCodeGraph(estate, {
        sources: pack.sources ?? ".*",
        coverage: pack.coverage,
        rules: pack.graph
      })
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
        [
          "fattura->dettaglio:jsp-form-to-page",
          "fattura->salvaFattura:jsp-form-action",
          "fattura->stampa:jsp-ajax-to-page"
        ]
      )
      assert.isFalse(
        graph.unresolved.some((item) => item.reason === "join-from"),
        graph.unresolved.map((item) => `${item.reason}:${item.node}`).join(", ")
      )
    })
  )
})

describe("j2ee-nextjs-spa on nested JSPs calling REST resources and server-side Java", () => {
  it.effect(
    "static and dynamic includes, ajax → REST resource, useBean, scriptlet and EL bean refs all link",
    () =>
      Effect.gen(function* () {
        const kits = yield* makeNodeWorkspace(kitsRoot)
        const pack = yield* loadPack(kits, "j2ee-nextjs/packs/j2ee-nextjs-spa")
        const estate = yield* makeMemoryWorkspace()
        yield* estate.write(
          "web/pages/fattura.jsp",
          [
            '<%@ include file="/pages/header.jspf" %>',
            '<jsp:include page="dettaglio.jsp"/>',
            '<jsp:useBean id="svc" class="com.bank.svc.InvoiceService" scope="request"/>',
            "<% Totals.compute(svc); %>",
            "<p>${invoiceBean.total}</p>",
            "<script>",
            "  $.ajax({ url: '/bank/rest/invoices/' + id, type: 'GET' });",
            '  $.getJSON("rest/reports/monthly");',
            "</script>",
            ""
          ].join("\n")
        )
        yield* estate.write("web/pages/header.jspf", "<h1>Banca</h1>\n")
        yield* estate.write("web/pages/dettaglio.jsp", "<p>detail</p>\n")
        yield* estate.write(
          "src/com/bank/rest/InvoiceResource.java",
          [
            "package com.bank.rest;",
            '@Path("/invoices")',
            "@Produces(MediaType.APPLICATION_JSON)",
            "public class InvoiceResource {",
            '  @GET @Path("/{id}") public Invoice get(@PathParam("id") long id) { return null; }',
            "}",
            ""
          ].join("\n")
        )
        yield* estate.write(
          "src/com/bank/rest/ReportResource.java",
          [
            "package com.bank.rest;",
            "@RestController",
            '@RequestMapping("/reports")',
            "public class ReportResource {}",
            ""
          ].join("\n")
        )
        yield* estate.write(
          "src/com/bank/svc/InvoiceService.java",
          "package com.bank.svc;\npublic class InvoiceService {}\n"
        )
        yield* estate.write(
          "src/com/bank/svc/Totals.java",
          "package com.bank.svc;\npublic class Totals {}\n"
        )
        yield* estate.write(
          "src/com/bank/web/InvoiceBean.java",
          "package com.bank.web;\n@Named\n@RequestScoped\npublic class InvoiceBean {}\n"
        )
        const { graph } = yield* buildCodeGraph(estate, {
          sources: pack.sources ?? ".*",
          coverage: pack.coverage,
          rules: pack.graph
        })
        const projected = projectToFiles(graph)
        assert.deepStrictEqual(
          projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
          [
            "fattura->InvoiceBean:jsp-el-bean",
            "fattura->InvoiceResource:jsp-ajax-rest",
            "fattura->InvoiceService:jsp-usebean",
            "fattura->ReportResource:jsp-ajax-rest",
            "fattura->Totals:jsp-static-call",
            "fattura->dettaglio:jsp-include",
            "fattura->header:jsp-static-include"
          ]
        )
        assert.isFalse(
          graph.unresolved.some(
            (item) => item.reason === "join-from" || item.reason === "isolated"
          ),
          graph.unresolved.map((item) => `${item.reason}:${item.node}`).join(", ")
        )
      })
  )
})
