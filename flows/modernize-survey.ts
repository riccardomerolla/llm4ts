// Legacy modernization phase 0: inventory the estate, refine its dependency graph, triage, and propose a human-approved wave plan.
//
// Runs rooted at the LEGACY repository (`--repo <legacy>`). Deterministic first:
// the graph comes from the pack's `sources:` regex and its `## Survey:` /
// `## Node:` / `## Edge:` / `## Join:` rules (no LLM; ADR 0030), cached under
// `.llm4ts/graph/<pack>.json` by file hash. What the scanner could not resolve
// becomes a bounded worklist for a read-only reasoning pass (attr fills and
// edges between EXISTING nodes, each verified against the cited source line),
// and finally triage classifies every unit rewrite | retire | wrap and slices
// the rewrites into dependency-coherent waves. The wave plan lands
// at docs/modernization/wave-plan.md with an UNCHECKED approval marker — a
// human reviews, flips `- [x] Approved`, and only then does modernize-extract
// start (LLM4TS_WAVE=<name> scopes extraction to one wave).
//
// Pack: LLM4TS_PACK=<dir> (default packs/cobol-springboot, resolved against the
// launch dir, then against the flow's own directory — the built-in packs). The
// two reasoning prompts take their stack-specific paragraph from the pack's
// `prompts/survey-refine.md` and `prompts/survey-triage.md` sidecars; the frame
// around them (`@llm4ts/flow/Survey`) never names a technology. Discovery
// counts only files the pack's `sources:` regex matches (minus `exclude:`),
// prunes VCS/dependency/build directories, and can be widened with
// LLM4TS_MAX_DISCOVER_RESULTS / LLM4TS_EXCLUDE_DIRS.
// Skip the LLM graph-refine pass with LLM4TS_GRAPH_REFINE=off.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { capped, withShrink } from "@llm4ts/flow/Context"
import {
  FlowAborted,
  Info,
  asReadOnly,
  coderFromEnv,
  makeNodeWorkspace,
  nodePlainFileStore,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { FlowEvents } from "@llm4ts/flow/FlowEvents"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { loadBenchRecords, renderBenchReport } from "@llm4ts/flow/BenchReport"
import {
  type SurveyGraph,
  nodeKind,
  renderSurveyGraphJson,
  renderSurveyInventory,
  surveyTriagePrompt
} from "@llm4ts/flow/Survey"
import {
  discoveryOverflowAdvice,
  legacySourceWorkspaceLimits,
  workspaceLimitsFromEnv,
  type WorkspaceShape
} from "@llm4ts/flow/Workspace"
import { withDraftApproval } from "@llm4ts/flow/Approval"
import { freshGraph, graphCachePath, updateGraphCache } from "@llm4ts/flow/GraphCache"
import {
  WorklistAnswer,
  mergeWorklist,
  renderWorklistReport,
  verifyWorklistAnswer,
  worklistAnswerJsonSchema,
  worklistBatches,
  worklistOf,
  worklistPrompt,
  type VerifiedWorklist
} from "@llm4ts/flow/GraphWorklist"
import { wholeView } from "@llm4ts/flow/GraphQuery"
import { renderClusterDiagrams, renderEntryPaths, renderGraphDot } from "@llm4ts/flow/GraphRender"
import type { Pack } from "@llm4ts/flow/Pack"

const ModDir = "docs/modernization"

class NodeTriage extends Schema.Class<NodeTriage>("NodeTriage")({
  name: Schema.String,
  disposition: Schema.String,
  rationale: Schema.String
}) {}

class WaveSlice extends Schema.Class<WaveSlice>("WaveSlice")({
  name: Schema.String,
  programs: Schema.Array(Schema.String),
  rationale: Schema.String
}) {}

class SurveyOutcome extends Schema.Class<SurveyOutcome>("SurveyOutcome")({
  triage: Schema.Array(NodeTriage),
  waves: Schema.Array(WaveSlice),
  notes: Schema.Array(Schema.String)
}) {}

const surveyOutcomeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    triage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          disposition: { type: "string", enum: ["rewrite", "retire", "wrap"] },
          rationale: { type: "string" }
        },
        required: ["name", "disposition", "rationale"]
      }
    },
    waves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          programs: { type: "array", items: { type: "string" } },
          rationale: { type: "string" }
        },
        required: ["name", "programs", "rationale"]
      }
    },
    notes: { type: "array", items: { type: "string" } }
  },
  required: ["triage", "waves", "notes"]
}

const tableCell = (text: string): string => text.split(/\r?\n/).join(" ").replaceAll("|", "\\|")

/** inventory.md (units, cluster diagrams, entry paths), graph.json and graph.dot. */
const writeGraphArtifacts = (
  repo: WorkspaceShape,
  pack: Pack,
  graph: SurveyGraph
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const programs = graph.nodes
      .filter((node) => nodeKind(node) === "file")
      .map((node) => node.name)
    const inventory = [
      renderSurveyInventory(graph),
      renderClusterDiagrams(graph, pack.consolidate ?? { cluster: [], context: [] }, programs),
      renderEntryPaths(graph)
    ].join("\n")
    yield* repo.write(join(ModDir, "inventory.md"), inventory)
    yield* repo.write(join(ModDir, "graph.json"), renderSurveyGraphJson(graph))
    yield* repo.write(join(ModDir, "graph.dot"), renderGraphDot(wholeView(graph), graph))
  })

const renderWavePlan = (
  outcome: SurveyOutcome,
  graph: SurveyGraph,
  projection: string | undefined
): string => {
  const triageRows = [...outcome.triage]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `| ${entry.name} | ${entry.disposition} | ${tableCell(entry.rationale)} |`)
  const waveSections = outcome.waves.map(
    (wave) =>
      [`## Wave: ${wave.name}`, "", wave.rationale, "", ...wave.programs.map((p) => `- ${p}`)].join(
        "\n"
      ) + "\n"
  )
  const notes =
    outcome.notes.length === 0
      ? []
      : ["## Needs a human look", "", ...outcome.notes.map((note) => `- ${note}`), ""]
  return (
    [
      "# Modernization wave plan",
      "",
      `${graph.nodes.length} unit(s) surveyed, ${outcome.waves.length} wave(s) proposed.`,
      "Scope extraction to one wave with `LLM4TS_WAVE=<name>` once this plan is approved.",
      "",
      "| Unit | Disposition | Rationale |",
      "| ---- | ----------- | --------- |",
      ...triageRows,
      "",
      ...waveSections,
      ...notes,
      ...(projection === undefined ? [] : [projection])
    ].join("\n") + "\n"
  )
}

const refineDisabled = (environment: Readonly<Record<string, string | undefined>>): boolean => {
  const value = environment.LLM4TS_GRAPH_REFINE?.trim().toLowerCase()
  return value === "off" || value === "0" || value === "false"
}

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Survey the legacy estate and propose a migration wave plan"
  )
  const coder = coderFromEnv(process.env)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const limits = workspaceLimitsFromEnv(process.env, legacySourceWorkspaceLimits)
        const repo = yield* makeNodeWorkspace(input.workDir, limits)
        const { pack } = yield* stage(
          context.events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )
        if (pack.graph.edges.length === 0 && pack.graph.joins.length === 0) {
          return yield* FlowAborted.make({
            message:
              `pack '${pack.name}' has no '## Survey:', '## Edge:' or '## Join:' sections — add the ` +
              "dependency-edge rules (CALL/COPY/EXEC PGM, ajax → servlet…) the graph should be built from"
          })
        }
        const cachePath = graphCachePath(input.workDir, pack.name)

        const fresh = yield* stage(
          context.events,
          "graph",
          Effect.gen(function* () {
            const built = yield* freshGraph(nodePlainFileStore, cachePath, pack, repo).pipe(
              // The cap is a guard against runaway trees, not a verdict on the
              // estate: name the three knobs instead of a bare limit number.
              Effect.catchTag("WorkspaceLimit", (error) =>
                Effect.fail(
                  error.operation === "discovery results"
                    ? FlowAborted.make({
                        message: `${input.workDir}: ${discoveryOverflowAdvice(limits)}`
                      })
                    : error
                )
              )
            )
            yield* writeGraphArtifacts(repo, pack, built.graph)
            yield* context.events.publish(
              Info.make({
                message:
                  `${built.graph.nodes.length} node(s), ${built.graph.edges.length} edge(s), ` +
                  `${built.graph.unresolved.length} unresolved` +
                  (built.reused ? " (graph cache reused)" : "")
              })
            )
            return built
          })
        )
        const graph = fresh.graph

        const refined = yield* stage(
          context.events,
          "graph refine",
          refineDisabled(process.env)
            ? context.events
                .publish(
                  Info.make({ message: "LLM4TS_GRAPH_REFINE=off — regex graph ships unrefined" })
                )
                .pipe(Effect.as(graph))
            : Effect.gen(function* () {
                const contents = new Map<string, string>()
                const load = (path: string) =>
                  contents.has(path)
                    ? Effect.void
                    : repo.read(path).pipe(
                        Effect.orElseSucceed(() => ""),
                        Effect.map((text) => void contents.set(path, text))
                      )
                const read = (path: string): string | undefined => contents.get(path)
                for (const file of new Set(graph.unresolved.map((item) => item.file))) {
                  yield* load(file)
                }
                const items = worklistOf(graph, read, pack.graph.worklistMax, pack.graph)
                if (items.length === 0) {
                  yield* context.events.publish(
                    Info.make({ message: "nothing unresolved — no LLM pass needed" })
                  )
                  return graph
                }
                let merged = graph
                const accepted: Array<VerifiedWorklist> = []
                const notes: Array<string> = []
                for (const batch of worklistBatches(items, pack.graph.batchSize)) {
                  const answer = yield* withShrink("graph worklist", (cap) =>
                    Effect.gen(function* () {
                      const prompt = yield* capped(
                        "worklist",
                        worklistPrompt(batch, pack.prompt("survey-refine")),
                        cap
                      )
                      return yield* structuredAndPublish(
                        context.reasoning,
                        context.events,
                        prompt,
                        WorklistAnswer,
                        worklistAnswerJsonSchema
                      )
                    })
                  ).pipe(Effect.provideService(FlowEvents, context.events))
                  for (const file of new Set([
                    ...answer.edges.map((edge) => edge.evidence.file),
                    ...answer.attrs.map((attr) => attr.evidence.file)
                  ])) {
                    yield* load(file)
                  }
                  const verified = verifyWorklistAnswer(answer, merged, read)
                  merged = mergeWorklist(merged, verified, pack.graph)
                  accepted.push(verified)
                  notes.push(...answer.notes)
                }
                const all: VerifiedWorklist = {
                  edges: accepted.flatMap((verified) => verified.edges),
                  fills: accepted.flatMap((verified) => verified.fills),
                  dropped: accepted.flatMap((verified) => verified.dropped)
                }
                yield* repo.write(
                  join(ModDir, "graph-refine.md"),
                  renderWorklistReport(items, all, notes)
                )
                yield* updateGraphCache(nodePlainFileStore, cachePath, fresh.cache, merged)
                yield* writeGraphArtifacts(repo, pack, merged)
                yield* context.events.publish(
                  Info.make({
                    message:
                      `${all.edges.length} edge(s) and ${all.fills.length} fill(s) accepted from ` +
                      `${items.length} unresolved item(s); ${all.dropped.length} dropped`
                  })
                )
                return merged
              })
        )

        // Survey's two prompts scale with UNIT COUNT, not file contents, so
        // they are the least likely of the phases to trip the budget — cap and
        // record only. Chunking the graph by connected component is
        // deliberately deferred until the cap is observed to actually fire.
        const outcome = yield* stage(
          context.events,
          "triage",
          withShrink("survey triage", (cap) =>
            Effect.gen(function* () {
              const prompt = yield* capped(
                "inventory",
                surveyTriagePrompt(refined, renderSurveyInventory(refined), {
                  rules: pack.survey,
                  guidance: pack.prompt("survey-triage")
                }),
                cap
              )
              return yield* structuredAndPublish(
                context.reasoning,
                context.events,
                prompt,
                SurveyOutcome,
                surveyOutcomeJsonSchema
              )
            })
          ).pipe(Effect.provideService(FlowEvents, context.events))
        )

        // When modernize-bench has measured real runs, the plan carries a
        // per-wave cost projection sized to wave 1.
        const projection = yield* stage(
          context.events,
          "projection",
          Effect.gen(function* () {
            const records = yield* loadBenchRecords(
              nodePlainFileStore,
              join(input.workspace, "bench-results.jsonl")
            ).pipe(Effect.orElseSucceed(() => []))
            if (records.length === 0) {
              yield* context.events.publish(
                Info.make({
                  message:
                    "no bench-results.jsonl next to the launch directory — wave plan ships " +
                    "without a cost projection (run modernize-bench to measure, then rerun)"
                })
              )
              return undefined
            }
            const first = outcome.waves[0]?.programs.length ?? 0
            return [
              `## Cost projection (wave-1, ${first} program(s), from measured runs)`,
              "",
              renderBenchReport(records, first > 0 ? first : undefined),
              "",
              "Other waves: rerun modernize-bench with LLM4TS_BENCH_MODE=report and",
              "LLM4TS_BENCH_PROJECT=<programs>.",
              ""
            ].join("\n")
          })
        )

        yield* stage(
          context.events,
          "wave plan",
          repo.write(
            join(ModDir, "wave-plan.md"),
            withDraftApproval(renderWavePlan(outcome, refined, projection))
          )
        )
        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(
              `modernize(${pack.name}): survey — ${refined.nodes.length} unit(s), ` +
                `${outcome.waves.length} wave(s) proposed`
            )
            .pipe(Effect.asVoid)
        )
        yield* context.events.publish(
          Info.make({
            message:
              `review ${ModDir}/wave-plan.md, flip '- [x] Approved', then run modernize-extract ` +
              "(LLM4TS_WAVE=<name> scopes it to one wave)"
          })
        )
      })
  )
})

runFlowMain(program)
