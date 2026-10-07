import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  WorklistAnswer,
  mergeWorklist,
  renderWorklistReport,
  verifyWorklistAnswer,
  worklistBatches,
  worklistOf,
  worklistPrompt
} from "@llm4ts/flow/GraphWorklist"
import { buildCodeGraph } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { legacyMiniFiles, loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const contents = (path: string): string | undefined => legacyMiniFiles[path]

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

describe("graph worklist", () => {
  it.effect(
    "lists unresolved items highest-degree first with context and lexical candidates, capped",
    () =>
      Effect.gen(function* () {
        const { graph, pack } = yield* built
        const items = worklistOf(graph, contents, 10, pack.graph)
        assert.strictEqual(items.length, 6)
        // 0300-POST has three edges touching it; isolated files have none.
        assert.strictEqual(items[0]?.unresolved.node, "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST")
        assert.include(items[0]?.context, "CALL 'AUDITLOG'")
        const dynamic = items.find((item) => item.unresolved.reason === "missing-attr")!
        assert.include(dynamic.context, "$.post(base + '/dynamic')")
        assert.isTrue(
          dynamic.candidates.some((candidate) => candidate.id.startsWith("servlet-mapping:"))
        )
        assert.strictEqual(worklistOf(graph, contents, 2).length, 2)
        assert.deepStrictEqual(worklistBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        const prompt = worklistPrompt(items.slice(0, 2), "Stack guidance here.")
        assert.include(prompt, "Stack guidance here.")
        assert.include(prompt, "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST")
        assert.include(prompt, '"attrs"')
        assert.include(prompt, "never invent a node")
      })
  )

  it.effect(
    "verifies evidence within two lines, drops wrong lines and unknown endpoints, merges the rest and re-joins",
    () =>
      Effect.gen(function* () {
        const { graph, pack } = yield* built
        const answer = WorklistAnswer.make({
          edges: [
            // accepted: snippet present on line 13 (stated 12, within two)
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
              to: "FEECALC",
              kind: "audit-call",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 12,
                snippet: "CALL 'AUDITLOG' USING WS-RECORD."
              }
            },
            // dropped: snippet is three lines away
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN",
              to: "header",
              kind: "far",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 10,
                snippet: "CALL 'FEECALC' USING WS-AMOUNT."
              }
            },
            // dropped: endpoint is a literal no node owns
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
              to: "AUDITLOG",
              kind: "calls",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 13,
                snippet: "CALL 'AUDITLOG' USING WS-RECORD."
              }
            },
            // dropped: duplicate of a scanner edge
            {
              from: "fattura",
              to: "header",
              kind: "jsp-include",
              evidence: {
                file: "web/fattura.jsp",
                line: 2,
                snippet: '<jsp:include page="/web/header.jsp"/>'
              }
            }
          ],
          attrs: [
            {
              node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
              key: "url",
              value: "/api/dynamic",
              evidence: {
                file: "web/js/invoice.js",
                line: 6,
                snippet: "$.post(base + '/dynamic');"
              }
            },
            // dropped: unknown node
            {
              node: "ajax-dynamic:web/js/invoice.js#ghost",
              key: "url",
              value: "/x",
              evidence: {
                file: "web/js/invoice.js",
                line: 6,
                snippet: "$.post(base + '/dynamic');"
              }
            }
          ],
          notes: ["AUDITLOG is a platform service"]
        })
        const verified = verifyWorklistAnswer(answer, graph, contents)
        assert.strictEqual(verified.edges.length, 1)
        assert.strictEqual(verified.edges[0]?.origin, "llm")
        assert.strictEqual(verified.edges[0]?.confidence, "inferred")
        assert.strictEqual(verified.edges[0]?.mechanism, "llm")
        assert.strictEqual(verified.edges[0]?.evidence?.line, 13)
        assert.strictEqual(verified.fills.length, 1)
        assert.deepStrictEqual(verified.dropped.map((drop) => drop.reason).sort(), [
          "duplicate of an existing edge",
          "snippet not found within two lines of line 10",
          "unknown endpoint: AUDITLOG",
          "unknown node: ajax-dynamic:web/js/invoice.js#ghost"
        ])
        const merged = mergeWorklist(graph, verified, pack.graph)
        assert.isTrue(merged.edges.some((edge) => edge.kind === "audit-call"))
        assert.isTrue(
          merged.edges.some(
            (edge) =>
              edge.from === "ajax-dynamic:web/js/invoice.js#base + '/dynamic'" &&
              edge.to === "servlet-mapping:web/WEB-INF/web.xml#report" &&
              edge.origin === "llm"
          )
        )
        assert.strictEqual(merged.fills.length, 1)
        const report = renderWorklistReport(worklistOf(graph, contents, 10), verified, answer.notes)
        assert.include(report, "1 edge(s) and 1 attr fill(s) accepted")
        assert.include(report, "snippet not found")
        assert.include(report, "AUDITLOG is a platform service")
      })
  )
})
