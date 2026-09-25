// Turn SOAP evidence into a REST design: per-operation analysis of the masked samples (field presence, codes, faults, pagination, schema findings).
//
// Runs after soap-sample, rooted at the same repository. The task text is a
// command:
//
//   llm4ts run soap-design --repo . "analyse"                 every operation
//   llm4ts run soap-design --repo . "analyse cercaMovimenti"
//
// Writes .llm4ts/soap/<service>/analysis/<operation>.md and .json from the
// recorded exchanges: which response fields are present, empty, or never
// seen; values outside declared enumerations and undeclared code lists;
// business outcome codes inside successful responses; SOAP faults; where
// responses break the schema; pagination style; latency. No model call.
// The design step that cites this evidence follows in the next slice of
// specs/pending/soap-ace-kit.md. LLM4TS_SOAP_SERVICE picks the service
// when several were discovered.
import * as Effect from "effect/Effect"
import {
  FlowAborted,
  Info,
  makeNodeWorkspace,
  mock,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"
import { analysisPaths, writeAnalyses } from "./lib/soap/Analysis.ts"
import { operationByName } from "./lib/soap/Catalog.ts"
import { loadCatalog } from "./lib/soap/Discover.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("analyse")
  const [command = "analyse", ...args] = input.prompt.trim().split(/\s+/)
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: mock,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const workspace = yield* makeNodeWorkspace(input.workDir)
        const requested = process.env.LLM4TS_SOAP_SERVICE?.trim()
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
        if (command !== "analyse" && command !== "analyze") {
          return yield* FlowAborted.make({
            message: `unknown command ${command}; available: analyse [operation]`
          })
        }
        const operations =
          args.length === 0 ? catalog.operations.map((operation) => operation.name) : args
        for (const operation of operations) {
          if (operationByName(catalog, operation) === undefined) {
            return yield* FlowAborted.make({ message: `unknown operation ${operation}` })
          }
        }
        const analyses = yield* writeAnalyses(workspace, catalog, service, operations)
        for (const analysis of analyses) {
          yield* say(
            `${analysis.operation}: ${analysis.exchanges} exchanges, ${analysis.outcomes.length} outcome codes, ${analysis.faults.length} faults, ${analysis.findings.length} schema findings, ${analysis.observations.length} observations → ${analysisPaths(service, analysis.operation).markdown}`
          )
        }
      })
  )
})

runFlowMain(program)
