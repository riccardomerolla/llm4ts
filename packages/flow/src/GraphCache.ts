import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "./FlowError.ts"
import { graphRulesHash, type GraphRules } from "./GraphRules.ts"
import { loadVersioned, saveVersioned, type PlainFileStoreShape } from "./Persistence.ts"
import type { CoverageRule } from "./SpecChecks.ts"
import {
  SurveyGraph,
  applyFillsAndJoins,
  buildCodeGraph,
  edgeOrigin,
  nodeAttrs,
  nodeId,
  type CodeGraphBuild
} from "./Survey.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

/**
 * The distilled graph cache (ADR 0030 decision 5): `.llm4ts/graph/<pack>.json`
 * holds the last built graph plus the sha256 of every scanned file and the
 * hash of the rules that shaped it. Freshness is content, not revision — a
 * dirty tree or a legacy repo outside the flow's git still caches correctly.
 */
export class GraphCacheMeta extends Schema.Class<GraphCacheMeta>("GraphCacheMeta")({
  version: Schema.Int,
  pack: Schema.String,
  rulesHash: Schema.String,
  rev: Schema.optionalKey(Schema.String),
  builtAt: Schema.String,
  files: Schema.Record(Schema.String, Schema.String)
}) {}

export class GraphCacheFile extends Schema.Class<GraphCacheFile>("GraphCacheFile")({
  meta: GraphCacheMeta,
  graph: SurveyGraph
}) {}

export const graphCacheVersion = 2

export const graphCachePath = (repoRoot: string, pack: string): string =>
  `${repoRoot.replace(/\/+$/, "")}/.llm4ts/graph/${pack}.json`

/** The cache, or undefined when absent, from another version, or corrupt — never fatal. */
export const loadGraphCache = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<GraphCacheFile | undefined, FlowError> =>
  loadVersioned(files, path, graphCacheVersion, GraphCacheFile).pipe(
    Effect.catchTag("UnsupportedSchemaVersion", () => Effect.succeed(undefined)),
    Effect.catchTag("PlanParse", () => Effect.succeed(undefined))
  )

export const saveGraphCache = (
  files: PlainFileStoreShape,
  path: string,
  cache: GraphCacheFile
): Effect.Effect<void, FlowError> =>
  saveVersioned(files, path, graphCacheVersion, GraphCacheFile, cache)

export const isFreshCache = (
  cache: GraphCacheFile,
  built: Readonly<Record<string, string>>,
  rulesHash: string
): boolean => {
  const cached = cache.meta.files
  const paths = Object.keys(built)
  return (
    cache.meta.rulesHash === rulesHash &&
    paths.length === Object.keys(cached).length &&
    paths.every((path) => cached[path] === built[path])
  )
}

/**
 * LLM and external contributions survive a rebuild while the file their
 * evidence cites is byte-identical and both endpoints still exist; joins are
 * then re-derived over the carried fills.
 */
export const carryContributions = (
  previous: GraphCacheFile,
  next: CodeGraphBuild,
  rules: GraphRules
): SurveyGraph => {
  const unchanged = (file: string): boolean =>
    previous.meta.files[file] !== undefined && previous.meta.files[file] === next.files[file]
  const nodes = new Map(next.graph.nodes.map((node) => [nodeId(node), node]))
  // A node id is positional within its file (`~2`, `~3`), so an endpoint is
  // only the same node when its own file is byte-identical too.
  const stable = (id: string): boolean => {
    const node = nodes.get(id)
    return node !== undefined && unchanged(node.path)
  }
  const scanned = new Set(next.graph.edges.map((edge) => `${edge.from}\u0000${edge.to}`))
  const carriedEdges = previous.graph.edges.filter(
    (edge) =>
      edgeOrigin(edge) !== "scanner" &&
      !(edge.mechanism ?? "").startsWith("join:") &&
      edge.evidence !== undefined &&
      unchanged(edge.evidence.file) &&
      stable(edge.from) &&
      stable(edge.to) &&
      // The scanner now sees this link itself: its exact edge wins.
      !scanned.has(`${edge.from}\u0000${edge.to}`)
  )
  const carriedFills = previous.graph.fills.filter((fill) => {
    const node = nodes.get(fill.node)
    return (
      node !== undefined &&
      unchanged(fill.evidence.file) &&
      unchanged(node.path) &&
      nodeAttrs(node)[fill.key] === undefined
    )
  })
  const seeded = SurveyGraph.make({
    nodes: next.graph.nodes,
    edges: [...next.graph.edges, ...carriedEdges],
    unresolved: next.graph.unresolved,
    fills: []
  })
  return applyFillsAndJoins(seeded, carriedFills, rules, Object.keys(next.files))
}

/** What `freshGraph` needs from a pack; `Pack` satisfies it structurally. */
export interface GraphPackShape {
  readonly name: string
  readonly sources: string | undefined
  readonly exclude: string | undefined
  readonly coverage: ReadonlyArray<CoverageRule>
  readonly graph: GraphRules
}

export interface FreshGraphOptions {
  readonly rev?: string
  readonly builtAt?: () => string
}

export interface FreshGraph {
  readonly graph: SurveyGraph
  readonly reused: boolean
  readonly cache: GraphCacheFile
}

/**
 * The graph for this pack and estate: the cache when every scanned file's hash
 * and the rule hash match, else a scanner rebuild with contributions carried
 * over, saved before it is returned. Scanning is the cost either way; the LLM
 * pass is what the cache protects.
 */
export const freshGraph = Effect.fn("@llm4ts/flow/GraphCache.freshGraph")(function* (
  files: PlainFileStoreShape,
  path: string,
  pack: GraphPackShape,
  workspace: WorkspaceShape,
  options: FreshGraphOptions = {}
): Effect.fn.Return<FreshGraph, FlowError | WorkspaceError> {
  const built = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    ...(pack.exclude === undefined ? {} : { exclude: pack.exclude }),
    coverage: pack.coverage,
    rules: pack.graph
  })
  const rulesHash = graphRulesHash(pack.graph)
  const previous = yield* loadGraphCache(files, path)
  if (previous !== undefined && isFreshCache(previous, built.files, rulesHash)) {
    return { graph: previous.graph, reused: true, cache: previous }
  }
  const graph =
    previous === undefined ? built.graph : carryContributions(previous, built, pack.graph)
  const cache = GraphCacheFile.make({
    meta: GraphCacheMeta.make({
      version: graphCacheVersion,
      pack: pack.name,
      rulesHash,
      ...(options.rev === undefined ? {} : { rev: options.rev }),
      builtAt: (options.builtAt ?? (() => new Date().toISOString()))(),
      files: built.files
    }),
    graph
  })
  yield* saveGraphCache(files, path, cache)
  return { graph, reused: false, cache }
})

/** After an LLM merge: same meta, the merged graph. */
export const updateGraphCache = (
  files: PlainFileStoreShape,
  path: string,
  cache: GraphCacheFile,
  graph: SurveyGraph
): Effect.Effect<void, FlowError> =>
  saveGraphCache(files, path, GraphCacheFile.make({ meta: cache.meta, graph }))
