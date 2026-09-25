// Turn SOAP evidence into a REST design: analysis of masked samples, the 1:1 mapping, an evidence-citing design proposal, its check, and the projected OpenAPI 3.1 contract.
//
// Runs after soap-sample, rooted at the same repository. The task text is a
// command:
//
//   llm4ts run soap-design --repo . "analyse [operation]"  analysis/<op>.md + .json from the exchanges
//   llm4ts run soap-design --repo . mapping                design/mapping.json + .md, the 1:1 base
//   llm4ts run soap-design --repo . design                 the reasoning seat drafts design/api-design.md
//   llm4ts run soap-design --repo . revise                 redraft against the check's findings
//   llm4ts run soap-design --repo . check                  the deterministic design review
//   llm4ts run soap-design --repo . openapi                design/openapi.yaml from an approved design
//
// The design is a typed overlay on the mapping: endpoints name their SOAP
// operations, models bind to XSD types, properties cite XSD paths, errors
// cite outcome codes and faults (see the kit README). `check` verifies
// coverage of every operation, verbs against the confirmed classes in
// operations.md, the style guide (api-style.md), every source path, enum maps
// against declared and observed values, and that every business error the
// samples showed is mapped. api-design.md is the approval file: editing its
// JSON block is the review, `Status: approved` the sign-off; an existing
// file is never overwritten by `design`. openapi refuses a design that is
// not approved or has check errors. LLM4TS_REASONER picks the seat that
// drafts (default claude); LLM4TS_SOAP_SERVICE picks the service.
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import {
  FlowAborted,
  Info,
  makeNodeWorkspace,
  mock,
  resolveFlowInput,
  runFlowMain,
  runNode,
  ScriptUsage
} from "@llm4ts/runner"
import { coderFor } from "@llm4ts/runner/Connectors"
import { analysisPaths, writeAnalyses } from "./lib/soap/Analysis.ts"
import { operationByName } from "./lib/soap/Catalog.ts"
import {
  blockingIssues,
  checkDesign,
  designPaths,
  parseDesignFile,
  renderDesignFile
} from "./lib/soap/Design.ts"
import { proposeDesign, reviseDesign } from "./lib/soap/DesignProposal.ts"
import {
  loadCatalog,
  loadOperationsFile,
  readIfPresent,
  serviceDirectory
} from "./lib/soap/Discover.ts"
import { encodeMapping, mapService, renderMapping } from "./lib/soap/Mapping.ts"
import { projectOpenApi, renderTypedYaml } from "./lib/soap/OpenApi.ts"

const usage =
  'usage: soap-design "analyse [operation] | mapping | design | revise | check | openapi"'

const styleGuide = () =>
  Effect.tryPromise({
    try: () => readFile(fileURLToPath(new URL("../api-style.md", import.meta.url)), "utf8"),
    catch: () => FlowAborted.make({ message: "cannot read the kit's api-style.md" })
  })

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("analyse")
  const [command = "analyse", ...args] = input.prompt.trim().split(/\s+/)
  const environment = process.env
  const drafting = command === "design" || command === "revise"
  const reasoner = drafting
    ? coderFor((environment.LLM4TS_REASONER ?? "claude").trim() || "claude")
    : undefined
  if (drafting && reasoner === undefined) {
    return yield* ScriptUsage.make({
      message: `unknown LLM4TS_REASONER '${environment.LLM4TS_REASONER ?? ""}'`
    })
  }

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: mock,
      ...(reasoner === undefined ? {} : { reasoning: reasoner }),
      environment
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const workspace = yield* makeNodeWorkspace(input.workDir)
        const requested = environment.LLM4TS_SOAP_SERVICE?.trim()
        const services = (yield* workspace.discover(".llm4ts/soap/*/catalog.json")).map(
          (path) => path.split("/")[2] ?? ""
        )
        const service =
          requested !== undefined && requested !== ""
            ? requested
            : services.length === 1
              ? services[0]
              : undefined
        if (service === undefined) {
          return yield* FlowAborted.make({
            message:
              services.length === 0
                ? "no discovered service here; run soap-discover first"
                : `several services (${services.join(", ")}); set LLM4TS_SOAP_SERVICE`
          })
        }
        const catalog = yield* loadCatalog(workspace, service)
        const operations = yield* loadOperationsFile(workspace, service)
        const paths = designPaths(serviceDirectory(service))
        const mapping = mapService(catalog)
        const allAnalyses = () => writeAnalyses(workspace, catalog, service)

        const report = (
          issues: ReadonlyArray<{ severity: string; where: string; detail: string }>
        ) =>
          Effect.forEach(
            issues,
            (issue) => say(`  ${issue.severity} ${issue.where}: ${issue.detail}`),
            { discard: true }
          )

        switch (command) {
          case "analyse":
          case "analyze": {
            const names =
              args.length === 0 ? catalog.operations.map((operation) => operation.name) : args
            for (const name of names) {
              if (operationByName(catalog, name) === undefined)
                return yield* FlowAborted.make({ message: `unknown operation ${name}` })
            }
            for (const analysis of yield* writeAnalyses(workspace, catalog, service, names)) {
              yield* say(
                `${analysis.operation}: ${analysis.exchanges} exchanges, ${analysis.outcomes.length} outcome codes, ${analysis.faults.length} faults, ${analysis.findings.length} schema findings, ${analysis.observations.length} observations → ${analysisPaths(service, analysis.operation).markdown}`
              )
            }
            return
          }
          case "mapping": {
            yield* workspace.write(paths.mapping, encodeMapping(mapping))
            yield* workspace.write(paths.mappingSummary, renderMapping(mapping))
            yield* say(`wrote ${paths.mapping} and ${paths.mappingSummary}`)
            return
          }
          case "design":
          case "revise": {
            const existing = yield* readIfPresent(workspace, paths.design)
            if (command === "design" && existing !== undefined) {
              return yield* FlowAborted.make({
                message: `${paths.design} exists; edit it, run "check", or "revise" to redraft it`
              })
            }
            if (command === "revise" && existing === undefined) {
              return yield* FlowAborted.make({
                message: `no ${paths.design} yet; run "design" first`
              })
            }
            const analyses = yield* allAnalyses()
            const style = yield* styleGuide()
            yield* workspace.write(paths.mapping, encodeMapping(mapping))
            yield* workspace.write(paths.mappingSummary, renderMapping(mapping))
            const base = { catalog, operations, mapping, analyses, style }
            const draft =
              existing === undefined
                ? yield* proposeDesign(context.reasoning, base)
                : yield* Effect.flatMap(parseDesignFile(existing), (file) =>
                    reviseDesign(context.reasoning, {
                      ...base,
                      current: file.design,
                      issues: checkDesign(file.design, { catalog, operations, analyses })
                    })
                  )
            const issues = checkDesign(draft, { catalog, operations, analyses })
            yield* workspace.write(paths.design, renderDesignFile(draft, issues, "proposed"))
            yield* say(
              `wrote ${paths.design}: ${draft.endpoints.length} endpoints, ${draft.models.length} models, ${blockingIssues(issues).length} errors, ${issues.length - blockingIssues(issues).length} warnings`
            )
            yield* report(issues)
            return
          }
          case "check":
          case "openapi": {
            const text = yield* readIfPresent(workspace, paths.design)
            if (text === undefined)
              return yield* FlowAborted.make({
                message: `no ${paths.design} yet; run "design" first`
              })
            const file = yield* parseDesignFile(text)
            const analyses = yield* allAnalyses()
            const issues = checkDesign(file.design, { catalog, operations, analyses })
            const errors = blockingIssues(issues)
            yield* workspace.write(
              paths.design,
              renderDesignFile(file.design, issues, file.approved ? "approved" : "proposed")
            )
            yield* say(
              `${paths.design}: ${file.approved ? "approved" : "proposed"}, ${errors.length} errors, ${issues.length - errors.length} warnings`
            )
            yield* report(issues)
            if (command === "check") return
            if (!file.approved)
              return yield* FlowAborted.make({
                message: "the design is not approved; set Status: approved after review"
              })
            if (errors.length > 0)
              return yield* FlowAborted.make({
                message: `the design has ${errors.length} check errors; fix them first`
              })
            yield* workspace.write(paths.openapi, renderTypedYaml(projectOpenApi(file.design)))
            yield* say(`wrote ${paths.openapi} (projected; do not edit)`)
            return
          }
          default:
            return yield* FlowAborted.make({ message: `unknown command ${command}\n${usage}` })
        }
      })
  )
})

runFlowMain(program)
