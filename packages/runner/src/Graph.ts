import { homedir } from "node:os"
import * as Effect from "effect/Effect"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { freshGraph, graphCachePath } from "@llm4ts/flow/GraphCache"
import {
  closureView,
  graphStats,
  neighborhood,
  pathBetween,
  probeResults,
  resolveNodeRef,
  searchNodes,
  viewOfPath,
  wholeView,
  type GraphView
} from "@llm4ts/flow/GraphQuery"
import { renderGraphDot, renderGraphMermaid, renderGraphText } from "@llm4ts/flow/GraphRender"
import type { Pack } from "@llm4ts/flow/Pack"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { nodeId, type SurveyGraph } from "@llm4ts/flow/Survey"
import {
  legacySourceWorkspaceLimits,
  workspaceLimitsFromEnv,
  type WorkspaceError,
  type WorkspaceShape
} from "@llm4ts/flow/Workspace"
import { kitTierPaths, type KitTierPaths } from "./Kits.ts"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"
import { makeNodeWorkspace } from "./NodeWorkspace.ts"
import { openPack, type PackNotFound } from "./Packs.ts"

/**
 * `llm4ts graph` (ADR 0030 decision 7): the code graph of a legacy estate as a
 * CLI. `build` is the scanner pass (the LLM worklist runs in modernize-survey);
 * every other command reads the cache through `freshGraph`, so a stale cache
 * is rebuilt rather than refused.
 */
export type GraphFormat = "text" | "json" | "mermaid" | "dot"

export type GraphCommand =
  | { readonly _tag: "build"; readonly repo: string; readonly pack?: string }
  | {
      readonly _tag: "query"
      readonly repo: string
      readonly pack?: string
      readonly text: string
      readonly kind?: string
      readonly hops: number
      readonly format: GraphFormat
      readonly all: boolean
      readonly force: boolean
    }
  | {
      readonly _tag: "path"
      readonly repo: string
      readonly pack?: string
      readonly from: string
      readonly to: string
      readonly max: number
      readonly format: GraphFormat
      readonly force: boolean
    }
  | {
      readonly _tag: "closure"
      readonly repo: string
      readonly pack?: string
      readonly program: string
      readonly max: number
      readonly format: GraphFormat
      readonly force: boolean
    }
  | {
      readonly _tag: "stats"
      readonly repo: string
      readonly pack?: string
      readonly format: GraphFormat
    }
  | {
      readonly _tag: "probe"
      readonly repo: string
      readonly pack?: string
      readonly format: GraphFormat
    }

export type GraphProgramError = FlowError | PackNotFound | WorkspaceError

export interface GraphDependencies {
  readonly files: PlainFileStoreShape
  readonly workspace: (root: string) => Effect.Effect<WorkspaceShape, WorkspaceError>
  readonly openPack: (
    repo: string,
    pack: string | undefined
  ) => Effect.Effect<Pack, GraphProgramError>
}

const render = (
  view: GraphView,
  graph: SurveyGraph,
  format: GraphFormat,
  force: boolean
): string => {
  switch (format) {
    case "json":
      return JSON.stringify(view, undefined, 2)
    case "mermaid":
      return renderGraphMermaid(view, graph, { force })
    case "dot":
      return renderGraphDot(view, graph)
    case "text":
      return renderGraphText(view)
  }
}

const counts = (record: Readonly<Record<string, number>>): string =>
  Object.entries(record)
    .map(([key, count]) => `${key} ${count}`)
    .join(", ")

const requireNode = (graph: SurveyGraph, ref: string): Effect.Effect<string, FlowAborted> => {
  const node = resolveNodeRef(graph, ref)
  return node === undefined
    ? Effect.fail(
        FlowAborted.make({
          message: `no node matches '${ref}' (try: llm4ts graph query "${ref}")`
        })
      )
    : Effect.succeed(nodeId(node))
}

export const makeGraphProgram = Effect.fn("@llm4ts/runner/Graph.make")(function* (
  command: GraphCommand,
  deps: GraphDependencies
): Effect.fn.Return<string, GraphProgramError> {
  const pack = yield* deps.openPack(command.repo, command.pack)
  const workspace = yield* deps.workspace(command.repo)
  const cachePath = graphCachePath(command.repo, pack.name)
  const { graph, reused } = yield* freshGraph(deps.files, cachePath, pack, workspace)
  switch (command._tag) {
    case "build": {
      const stats = graphStats(graph)
      return [
        `pack ${pack.name} — graph ${reused ? "reused from" : "written to"} ${cachePath}`,
        `nodes: ${stats.total.nodes} (${counts(stats.nodes)})`,
        `edges: ${stats.total.edges} (${counts(stats.edges)})`,
        `unresolved: ${stats.total.unresolved} (${counts(stats.unresolved) || "none"})`
      ].join("\n")
    }
    case "stats": {
      const stats = graphStats(graph)
      if (command.format === "json") {
        return JSON.stringify(stats, undefined, 2)
      }
      const rows = (label: string, record: Readonly<Record<string, number>>) =>
        Object.entries(record).map(([key, count]) => `${label} ${key}\t${count}`)
      return [
        "kind\tcount",
        ...rows("node", stats.nodes),
        ...rows("edge", stats.edges),
        ...rows("mechanism", stats.mechanism),
        ...rows("origin", stats.origin),
        ...rows("confidence", stats.confidence),
        ...rows("unresolved", stats.unresolved)
      ].join("\n")
    }
    case "query": {
      const hits = searchNodes(
        graph,
        command.text,
        command.kind === undefined ? {} : { kind: command.kind }
      )
      if (hits.length === 0) {
        return `no node matches '${command.text}'`
      }
      const view = command.all
        ? wholeView(graph)
        : neighborhood(
            graph,
            hits.map((hit) => nodeId(hit.node)),
            command.hops
          )
      return render(view, graph, command.format, command.force)
    }
    case "path": {
      const from = yield* requireNode(graph, command.from)
      const to = yield* requireNode(graph, command.to)
      const found = pathBetween(graph, from, to, command.max, { projected: true })
      const path = found.forward ?? found.backward
      if (path === undefined) {
        return `no path within ${command.max} hops between ${from} and ${to} in either direction`
      }
      const direction = found.forward === undefined ? `(reverse: ${to} → ${from})\n` : ""
      return `${direction}${render(viewOfPath(graph, path), graph, command.format, command.force)}`
    }
    case "closure":
      return render(
        closureView(graph, command.program, command.max),
        graph,
        command.format,
        command.force
      )
    case "probe": {
      const results = probeResults(graph, pack.graph.probes)
      if (command.format === "json") {
        return JSON.stringify(
          results.map((result) => ({
            name: result.probe.name,
            status: result.status,
            ...(result.path === undefined ? {} : { hops: result.path.length })
          })),
          undefined,
          2
        )
      }
      return results.length === 0
        ? `pack ${pack.name} declares no '## Probe:' section`
        : results
            .map(
              (result) =>
                `${result.probe.name}: ${result.status}${
                  result.path === undefined
                    ? ""
                    : ` via ${result.path.map((edge) => edge.kind).join(" → ")}`
                }`
            )
            .join("\n")
    }
  }
})

/** Node-backed dependencies: the disk, a legacy-sized workspace, packs from the kit tiers. */
export const nodeGraphDependencies = (
  environment: Readonly<Record<string, string | undefined>>,
  kits: KitTierPaths
): GraphDependencies => ({
  files: nodePlainFileStore,
  workspace: (root) =>
    makeNodeWorkspace(root, workspaceLimitsFromEnv(environment, legacySourceWorkspaceLimits)),
  openPack: (repo, pack) =>
    openPack({
      environment: { ...environment, ...(pack === undefined ? {} : { LLM4TS_PACK: pack }) },
      launchDir: repo,
      flowDir: repo,
      kits:
        kits.builtin === undefined
          ? kitTierPaths({ cwd: repo, homeDir: homedir(), environment })
          : kits
    }).pipe(Effect.map((opened) => opened.pack))
})
