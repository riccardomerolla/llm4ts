// One pass from a WSDL to a design draft: discover, a request for every operation, a read-only probe with values chained between calls, analyses, the 1:1 mapping, and a drafted REST design; stops only where a person decides.
//
// The task text is the WSDL location (path or http(s) URL), as for
// soap-discover; without one it continues from the discovered service:
//
//   llm4ts run soap-explore --repo ~/work/conti-api ./wsdl/DemoBank.wsdl
//   llm4ts run soap-explore --repo .                  # rerun: continue where it stopped
//   llm4ts run soap-explore --repo . -- --refresh     # call the probed operations again
//
// Steps, each keeping what already exists (so a rerun continues):
//
//   1. discover     catalog.json/.md; operations.md with proposed classes
//   2. requests     samples/<op>/happy-path.request.yaml for every operation
//   3. probe        calls read operations only, producers first; values a
//                   response returns seed the next request (live in memory,
//                   masked on disk). Before operations.md is confirmed an
//                   operation is probed only in dev/test when the name
//                   heuristic and the judgment seat (LLM4TS_JUDGMENT_PROVIDER)
//                   both say read. Mutating operations are never called.
//   4. evidence     analysis/<op>.md, design/mapping.json/.md
//   5. design       the reasoning seat (LLM4TS_REASONER, default claude)
//                   drafts design/api-design.md, check, one revise round;
//                   an existing design is only checked. --no-design skips.
//   6. report       explore.md: per operation what happened, and the next
//                   command for every gap
//
// Calls need auth.json (at least {"environment": "test"}); explore never
// writes it. Approval stays human: operations.md `Status: confirmed`,
// api-design.md `Status: approved`. LLM4TS_SOAP_SERVICE names the service
// (and the auth.json used to fetch a URL); LLM4TS_SOAP_STUB=<dir> answers
// calls from <dir>/<operation>.xml instead of the network.
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
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
import { coderFor, judgmentConnectorFromEnvironment } from "@llm4ts/runner/Connectors"
import { nodeSecretSource, resolveSide } from "./lib/soap/Auth.ts"
import { type WsdlCatalog } from "./lib/soap/Catalog.ts"
import { heuristicClass, judgeClass, type JudgedClass } from "./lib/soap/Classification.ts"
import {
  discoverService,
  loadAuthProfile,
  profilePath,
  loadCatalog,
  loadOperationsFile
} from "./lib/soap/Discover.ts"
import {
  designStep,
  explorePaths,
  exploreService,
  renderExploreReport,
  writeEvidence
} from "./lib/soap/Explore.ts"
import { makeTokenSource } from "./lib/soap/Sts.ts"
import { makeDirectoryStubTransport } from "./lib/soap/Stub.ts"
import { makeNodeSoapTransport, makeTransportDocumentLoader } from "./lib/soap/Transport.ts"
import { DocumentLoader } from "./lib/soap/Wsdl.ts"

const usage = 'usage: soap-explore [--refresh] [--no-design] "<wsdl path or URL>"'

const isUrl = (location: string): boolean => /^https?:\/\//i.test(location)

const parseExploreFlags = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let refresh = false
    let design = true
    const rest: Array<string> = []
    for (const argument of argv) {
      if (argument === "--refresh") refresh = true
      else if (argument === "--no-design") design = false
      else if (argument.startsWith("--refresh=") || argument.startsWith("--no-design="))
        return yield* ScriptUsage.make({ message: `${argument} takes no value\n${usage}` })
      else rest.push(argument)
    }
    return { refresh, design, rest }
  })

const styleGuide = () =>
  Effect.tryPromise({
    try: () =>
      readFile(fileURLToPath(new URL("../packs/ace12-rest/api-style.md", import.meta.url)), "utf8"),
    catch: () =>
      FlowAborted.make({ message: "cannot read the kit's packs/ace12-rest/api-style.md" })
  })

const program = Effect.gen(function* () {
  const flags = yield* parseExploreFlags(process.argv.slice(2))
  const input = yield* resolveFlowInput("", flags.rest)
  const raw = input.prompt.trim()
  const location =
    raw === "" ? undefined : isUrl(raw) || isAbsolute(raw) ? raw : resolve(input.workspace, raw)
  const environment = process.env
  const requested = environment.LLM4TS_SOAP_SERVICE?.trim() || undefined
  const judgment = yield* judgmentConnectorFromEnvironment()
  const reasonerName = (environment.LLM4TS_REASONER ?? "claude").trim() || "claude"
  const reasoner = flags.design ? coderFor(reasonerName) : undefined
  if (flags.design && reasoner === undefined) {
    return yield* ScriptUsage.make({ message: `unknown LLM4TS_REASONER '${reasonerName}'` })
  }

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: mock,
      ...(reasoner === undefined ? {} : { reasoning: reasoner }),
      ...(judgment === undefined ? {} : { judgment }),
      environment
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const workspace = yield* makeNodeWorkspace(input.workDir)
        const seat = judgment === undefined ? undefined : context.judgment

        // 1. discover (or continue from the discovered service)
        let service: string
        let catalog: WsdlCatalog
        let judged: Map<string, JudgedClass | undefined> | undefined
        if (location !== undefined) {
          const fetchProfile =
            requested === undefined
              ? undefined
              : yield* loadAuthProfile(
                  workspace,
                  requested,
                  environment.LLM4TS_SOAP_ENV?.trim() || undefined
                )
          const fetchSide = yield* resolveSide(nodeSecretSource(environment), fetchProfile?.fetch)
          const discovered = yield* discoverService({
            workspace,
            location,
            ...(requested === undefined ? {} : { service: requested }),
            ...(seat === undefined ? {} : { judgment: seat })
          }).pipe(
            Effect.provideService(
              DocumentLoader,
              makeTransportDocumentLoader(makeNodeSoapTransport(), fetchSide)
            )
          )
          service = discovered.service
          catalog = discovered.catalog
          // Classes judged at discovery are reused; otherwise judged below.
          if (discovered.proposals !== undefined && seat !== undefined) {
            judged = new Map(
              discovered.proposals.map((proposal) => [proposal.operation, proposal.judged])
            )
          }
          yield* say(
            `discovered ${service}: ${catalog.operations.length} operations, ${catalog.openQuestions.length} open questions`
          )
        } else {
          const services = (yield* workspace.discover(".llm4ts/soap/*/catalog.json")).map(
            (path) => path.split("/")[2] ?? ""
          )
          const picked = requested ?? (services.length === 1 ? services[0] : undefined)
          if (picked === undefined) {
            return yield* FlowAborted.make({
              message:
                services.length === 0
                  ? `nothing discovered here; give the WSDL\n${usage}`
                  : `several services (${services.join(", ")}); set LLM4TS_SOAP_SERVICE`
            })
          }
          service = picked
          catalog = yield* loadCatalog(workspace, service)
          yield* say(`continuing ${service}: ${catalog.operations.length} operations`)
        }

        const env = environment.LLM4TS_SOAP_ENV?.trim() || undefined
        const profile = yield* loadAuthProfile(workspace, service, env)
        if (profile !== undefined) yield* say(`profile: ${profilePath(service, env)}`)
        const operations = yield* loadOperationsFile(workspace, service)
        // Provisional probing asks the judgment only where the listed class
        // and the heuristic already say read.
        if (seat !== undefined && judged === undefined && operations?.confirmed !== true) {
          const candidates = catalog.operations.filter(
            (operation) =>
              operations?.classes.get(operation.name) === "read" &&
              heuristicClass(operation.name).class === "read"
          )
          judged = new Map(
            yield* Effect.forEach(candidates, (operation) =>
              Effect.map(
                judgeClass(seat, catalog, operation),
                (answer) => [operation.name, answer] as const
              )
            )
          )
        }

        // 2-3. requests and the probe
        const stub = environment.LLM4TS_SOAP_STUB?.trim()
        const transport =
          stub === undefined || stub === ""
            ? makeNodeSoapTransport()
            : makeDirectoryStubTransport(resolve(input.workspace, stub), catalog)
        if (stub !== undefined && stub !== "")
          yield* say(`LLM4TS_SOAP_STUB: answering from ${stub}, not the network`)
        const result = yield* exploreService({
          workspace,
          catalog,
          service,
          profile,
          operations,
          judged,
          secrets: nodeSecretSource(environment),
          transport,
          ...(profile?.sts === undefined
            ? {}
            : {
                token: yield* makeTokenSource({
                  workspace,
                  service,
                  config: profile.sts,
                  secrets: nodeSecretSource(environment),
                  transport
                })
              }),
          refresh: flags.refresh,
          progress: (line) => say(`  ${line}`)
        })
        const probed = result.decisions.filter((decision) => decision.probe).length
        yield* say(
          `probe: ${probed} of ${catalog.operations.length} operations callable now${profile === undefined ? " (no auth.json)" : ""}`
        )

        // 4. evidence
        const evidence = yield* writeEvidence(workspace, catalog, service)

        // 5. design
        const design = yield* designStep({
          workspace,
          catalog,
          service,
          operations,
          evidence,
          reasoning: flags.design ? context.reasoning : { off: "--no-design" },
          style: yield* styleGuide()
        })
        yield* say(
          design.kind === "skipped" || design.kind === "failed"
            ? `design: not drafted (${design.kind === "skipped" ? design.reason : design.detail})`
            : `design: ${design.kind}, ${design.approved ? "approved" : "proposed"}, ${design.errors} errors, ${design.warnings} warnings`
        )

        // 6. report
        const report = renderExploreReport({
          service,
          catalog,
          profile,
          operations,
          result,
          design,
          evidence
        })
        const path = explorePaths(service).report
        yield* workspace.write(path, report)
        const next = report.split("## Next")[1]?.trim().split("\n") ?? []
        yield* say(`wrote ${path}; next:`)
        for (const line of next) yield* say(`  ${line}`)
      })
  )
})

runFlowMain(program)
