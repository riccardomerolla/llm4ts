import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  freshGraph,
  graphCachePath,
  loadGraphCache,
  updateGraphCache
} from "@llm4ts/flow/GraphCache"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { Fill, SurveyEdge, SurveyGraph, applyFillsAndJoins } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const setup = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const memory = yield* makeMemoryPlainFileStore()
  const path = graphCachePath("/estate", pack.name)
  return { workspace, pack, files: memory.store, path }
})

const llmEdge = SurveyEdge.make({
  from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
  to: "FEECALC",
  kind: "dynamic-call",
  origin: "llm",
  confidence: "inferred",
  mechanism: "llm",
  evidence: { file: "cobol/ACCTXFR.cbl", line: 13, snippet: "CALL 'AUDITLOG' USING WS-RECORD." }
})
const llmFill = Fill.make({
  node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
  key: "url",
  value: "/api/dynamic",
  evidence: { file: "web/js/invoice.js", line: 6, snippet: "$.post(base + '/dynamic');" }
})

describe("graph cache", () => {
  it.effect("builds once, reuses while hashes and rules match, rebuilds on a changed file", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      assert.strictEqual(graphCachePath("/estate", "p"), "/estate/.llm4ts/graph/p.json")
      const first = yield* freshGraph(files, path, pack, workspace, {
        rev: "abc",
        builtAt: () => "t0"
      })
      assert.isFalse(first.reused)
      assert.strictEqual(first.cache.meta.rev, "abc")
      const second = yield* freshGraph(files, path, pack, workspace)
      assert.isTrue(second.reused)
      yield* workspace.write("web/header.jsp", "<div>changed</div>\n")
      const third = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(third.reused)
      assert.strictEqual(
        (yield* loadGraphCache(files, path))?.meta.files["web/header.jsp"],
        third.cache.meta.files["web/header.jsp"]
      )
    })
  )

  it.effect("carries LLM edges and fills whose evidence file is unchanged and drops the rest", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      const first = yield* freshGraph(files, path, pack, workspace)
      const merged = applyFillsAndJoins(
        SurveyGraph.make({ ...first.graph, edges: [...first.graph.edges, llmEdge] }),
        [llmFill],
        pack.graph
      )
      yield* updateGraphCache(files, path, first.cache, merged)
      // Unrelated edit: both contributions survive and the fill's join is re-derived.
      yield* workspace.write("web/header.jsp", "<div>changed</div>\n")
      const after = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(after.reused)
      assert.isTrue(
        after.graph.edges.some((edge) => edge.kind === "dynamic-call" && edge.origin === "llm")
      )
      assert.strictEqual(after.graph.fills.length, 1)
      assert.isTrue(
        after.graph.edges.some(
          (edge) =>
            edge.from === llmFill.node && edge.to === "servlet-mapping:web/WEB-INF/web.xml#report"
        )
      )
      // Edit the evidence file of the edge: only the edge drops.
      yield* workspace.write("cobol/ACCTXFR.cbl", "       0100-MAIN.\n")
      const again = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(again.graph.edges.some((edge) => edge.kind === "dynamic-call"))
      assert.strictEqual(again.graph.fills.length, 1)
    })
  )

  it.effect("a changed rule set invalidates the cache even when no file changed", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      yield* freshGraph(files, path, pack, workspace)
      const narrower = { ...pack, graph: { ...pack.graph, joins: pack.graph.joins.slice(1) } }
      const rebuilt = yield* freshGraph(files, path, narrower, workspace)
      assert.isFalse(rebuilt.reused)
    })
  )

  it.effect("a cache with another schema version is rebuilt, not an error", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      yield* files.writeAtomic(path, JSON.stringify({ schemaVersion: 1, value: {} }))
      const result = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(result.reused)
      assert.isAbove(result.graph.nodes.length, 0)
    })
  )
})
