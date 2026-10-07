import * as Effect from "effect/Effect"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"

/**
 * The shared fixture estate for the code graph (ADR 0030): a JSP page, a
 * jQuery file with resolvable and dynamic ajax calls, a `web.xml` with exact,
 * prefix and extension mappings plus an orphan declaration, servlets, an ESB
 * wrapper, and two COBOL programs with a section, paragraphs, PERFORM, THRU,
 * GO TO and CALL. Every graph test reads the same estate.
 */
export const legacyMiniFiles: Readonly<Record<string, string>> = {
  "web/fattura.jsp": [
    '<%@ page contentType="text/html" %>',
    '<jsp:include page="/web/header.jsp"/>',
    '<form action="salvaFattura.do" method="post"><input name="importo"/></form>',
    '<script src="js/invoice.js"></script>',
    ""
  ].join("\n"),
  "web/header.jsp": '<div class="header">Banca</div>\n',
  "web/js/invoice.js": [
    "$(function () {",
    "  $('#save').on('click', function () {",
    "    $.ajax({ url: '${ctx}/salvaFattura?id=' + id, type: 'POST' });",
    "  });",
    "  $.get('/api/report/monthly');",
    "  $.post(base + '/dynamic');",
    "});",
    ""
  ].join("\n"),
  "web/WEB-INF/web.xml": [
    "<web-app>",
    "  <servlet>",
    "    <servlet-name>invoice</servlet-name>",
    "    <servlet-class>com.legacy.InvoiceServlet</servlet-class>",
    "  </servlet>",
    "  <servlet>",
    "    <servlet-name>report</servlet-name>",
    "    <servlet-class>com.legacy.ReportServlet</servlet-class>",
    "  </servlet>",
    "  <servlet>",
    "    <servlet-name>orphan</servlet-name>",
    "    <servlet-class>com.legacy.OrphanServlet</servlet-class>",
    "  </servlet>",
    "  <servlet-mapping>",
    "    <servlet-name>invoice</servlet-name>",
    "    <url-pattern>/salvaFattura</url-pattern>",
    "  </servlet-mapping>",
    "  <servlet-mapping>",
    "    <servlet-name>report</servlet-name>",
    "    <url-pattern>/api/*</url-pattern>",
    "  </servlet-mapping>",
    "  <servlet-mapping>",
    "    <servlet-name>invoice</servlet-name>",
    "    <url-pattern>*.do</url-pattern>",
    "  </servlet-mapping>",
    "</web-app>",
    ""
  ].join("\n"),
  "src/com/legacy/InvoiceServlet.java": [
    "package com.legacy;",
    "public class InvoiceServlet extends HttpServlet {",
    "  protected void doPost(HttpServletRequest req, HttpServletResponse res) {",
    '    new EsbInvoiceService().call("SalvaFattura", req);',
    "  }",
    "}",
    ""
  ].join("\n"),
  "src/com/legacy/ReportServlet.java":
    "package com.legacy;\npublic class ReportServlet extends HttpServlet {}\n",
  "src/com/legacy/OrphanServlet.java":
    "package com.legacy;\npublic class OrphanServlet extends HttpServlet {}\n",
  "src/com/legacy/EsbInvoiceService.java": [
    "package com.legacy;",
    "public class EsbInvoiceService {",
    "  public Object call(String operation, Object request) { return null; }",
    "}",
    ""
  ].join("\n"),
  "cobol/ACCTXFR.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. ACCTXFR.",
    "       PROCEDURE DIVISION.",
    "       MAIN-LOGIC SECTION.",
    "       0100-MAIN.",
    "           PERFORM 0200-VALIDATE THRU 0300-POST.",
    "           CALL 'FEECALC' USING WS-AMOUNT.",
    "       0200-VALIDATE.",
    "           PERFORM 9999-MISSING.",
    "       0250-CHECK.",
    "           GO TO 0300-POST.",
    "       0300-POST.",
    "           CALL 'AUDITLOG' USING WS-RECORD.",
    ""
  ].join("\n"),
  "cobol/FEECALC.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. FEECALC.",
    "       PROCEDURE DIVISION.",
    "       0100-COMPUTE-FEE.",
    "           MOVE 1 TO WS-FEE.",
    ""
  ].join("\n")
}

export const legacyMiniPackManifest = `# Pack: legacy-mini

source: jsp
sources: .*\\.(jsp|js|java|xml|cbl)
programs: .*\\.(jsp|cbl)

## Coverage: cobol-paragraph

files: .*\\.cbl
unit: ^ {7}(\\d{4}-[A-Z0-9-]+)\\.

## Survey: jsp-include

files: .*\\.jsp
unit: <jsp:include page="([^"]+)"

## Node: ajax-call

files: .*\\.(js|jsp)
pattern: (?:url:\\s*|\\$\\.(?:get|post)\\(\\s*)['"](?<name>[^'"]+)['"]
attrs: url=name

## Node: ajax-dynamic

files: .*\\.js
pattern: \\$\\.(?:ajax|get|post)\\(\\s*(?<name>[A-Za-z_][A-Za-z0-9_.]*\\s*\\+\\s*['"][^'"]*['"])

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

## Node: cobol-section

files: .*\\.cbl
pattern: ^ {7}(?<name>[A-Z0-9][A-Z0-9-]*) +SECTION\\.

## Node: cobol-paragraph

files: .*\\.cbl
pattern: ^ {7}(?<name>\\d{4}-[A-Z0-9-]+)\\.

## Edge: performs

files: .*\\.cbl
pattern: PERFORM +(?<to>\\d{4}-[A-Z0-9-]+)(?: +THRU +(?<thru>\\d{4}-[A-Z0-9-]+))?
from: cobol-paragraph
to: cobol-paragraph

## Edge: goes-to

files: .*\\.cbl
pattern: GO +TO +(?<to>\\d{4}-[A-Z0-9-]+)
from: cobol-paragraph
to: cobol-paragraph

## Edge: calls

files: .*\\.cbl
pattern: CALL '(?<to>[A-Z0-9]+)'
from: cobol-paragraph

## Edge: invokes-esb

files: .*\\.java
pattern: \\.call\\("(?<to>[A-Za-z0-9]+)"
to: esb-call

## Join: jsp-ajax-target

from: ajax-call.url
to: servlet-mapping.url
match: url

## Join: jsp-ajax-target

from: ajax-dynamic.url
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

## Probe: monthly-report

from: invoice
to: ReportServlet

## Probe: orphan

from: fattura
to: OrphanServlet

## Consolidate

- cluster: jsp-ajax-target, jsp-form-action
- context: jsp-include

## Graph

- worklist-max: 10
- batch-size: 4
`

export const writeLegacyMini = (workspace: WorkspaceShape): Effect.Effect<void, unknown> =>
  Effect.forEach(Object.entries(legacyMiniFiles), ([path, text]) => workspace.write(path, text), {
    discard: true
  })

export const loadLegacyMiniPack = (workspace: WorkspaceShape): Effect.Effect<Pack, unknown> =>
  workspace
    .write("pack/pack.md", legacyMiniPackManifest)
    .pipe(Effect.andThen(loadPack(workspace, "pack")))
