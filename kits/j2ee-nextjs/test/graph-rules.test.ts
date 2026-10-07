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
