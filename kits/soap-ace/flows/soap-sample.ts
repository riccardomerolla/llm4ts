// Author, call, and import SOAP samples: YAML request files from the catalog, masked recorded exchanges, SoapUI import, LLM-proposed scenario sets.
//
// Runs after soap-discover, rooted at the same repository. The task text is
// a command:
//
//   llm4ts run soap-sample --repo . "list"                    requests and exchanges per operation
//   llm4ts run soap-sample --repo . "init cercaMovimenti"     a commented skeleton (happy-path)
//   llm4ts run soap-sample --repo . "init cercaMovimenti fine-mese"
//   llm4ts run soap-sample --repo . "propose cercaMovimenti"  scenario set from the reasoning seat
//   llm4ts run soap-sample --repo . "import ./DemoBank-soapui-project.xml"
//   llm4ts run soap-sample --repo . "call cercaMovimenti/happy-path"
//   llm4ts run soap-sample --repo . "call cercaMovimenti"     every request of the operation
//   llm4ts run soap-sample --repo . -- --allow-mutating revocaBonifico "call revocaBonifico/gia-eseguito"
//
// Requests live in .llm4ts/soap/<service>/samples/<operation>/<name>.request.yaml
// (or .request.xml). A call validates the request (an invalid one is never
// sent), checks the confirmed class in operations.md and the environment's
// mutating policy, sends it with auth.json's call side (Basic/Bearer, mTLS,
// WS-Security), and records a masked, auth-stripped exchange beside it.
// Flags: --allow-mutating <operation> (exactly one), --keep-raw (unmasked
// response under the gitignored raw/). LLM4TS_SOAP_SERVICE picks the service
// when several were discovered; LLM4TS_SOAP_STUB=<dir> answers calls from
// <dir>/<operation>.xml instead of the network (rehearsals); LLM4TS_REASONER
// picks the seat that proposes scenarios (default claude).
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
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
import { terminalInteraction } from "@llm4ts/runner/TerminalInteraction"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { nodeSecretSource } from "./lib/soap/Auth.ts"
import { callOperation } from "./lib/soap/Call.ts"
import { operationByName, type WsdlCatalog } from "./lib/soap/Catalog.ts"
import { effectiveClass } from "./lib/soap/Classification.ts"
import {
  loadAuthProfile,
  loadCatalog,
  loadOperationsFile,
  readIfPresent
} from "./lib/soap/Discover.ts"
import {
  isSampleName,
  listRequests,
  loadMaskingKey,
  loadMaskingOverrides,
  readExchanges,
  renderRequestFile,
  samplePaths,
  seedsForService
} from "./lib/soap/Samples.ts"
import { proposeScenarios } from "./lib/soap/Scenarios.ts"
import { importSoapUiProject } from "./lib/soap/SoapUiImport.ts"
import { makeDirectoryStubTransport } from "./lib/soap/Stub.ts"
import { makeNodeSoapTransport } from "./lib/soap/Transport.ts"

const usage = [
  'usage: soap-sample [--allow-mutating <operation>] [--keep-raw] "<command>"',
  "  list | init <operation> [name] | propose <operation> | import <soapui.xml>",
  "  call <operation>[/<name>] | call all"
].join("\n")

interface SampleFlags {
  readonly allowMutating: string | undefined
  readonly keepRaw: boolean
  readonly rest: ReadonlyArray<string>
}

const parseSampleFlags = (argv: ReadonlyArray<string>): Effect.Effect<SampleFlags, ScriptUsage> =>
  Effect.gen(function* () {
    let allowMutating: string | undefined
    let keepRaw = false
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index] ?? ""
      if (argument === "--keep-raw") keepRaw = true
      else if (argument === "--allow-mutating" || argument.startsWith("--allow-mutating=")) {
        const value = argument.includes("=")
          ? argument.slice("--allow-mutating=".length)
          : argv[++index]
        if (value === undefined || value.trim() === "") {
          return yield* ScriptUsage.make({
            message: `--allow-mutating needs an operation name\n${usage}`
          })
        }
        allowMutating = value.trim()
      } else rest.push(argument)
    }
    return { allowMutating, keepRaw, rest }
  })

/** The service directory: LLM4TS_SOAP_SERVICE, or the only one discovered. */
const pickService = (workspace: WorkspaceShape, requested: string | undefined) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested !== "") return requested
    const catalogs = yield* workspace.discover(".llm4ts/soap/*/catalog.json")
    const services = catalogs.map((path) => path.split("/")[2] ?? "")
    if (services.length === 1) return services[0] ?? ""
    return yield* FlowAborted.make({
      message:
        services.length === 0
          ? "no discovered service here; run soap-discover first"
          : `several services (${services.join(", ")}); set LLM4TS_SOAP_SERVICE`
    })
  })

const requireOperation = (catalog: WsdlCatalog, name: string | undefined) =>
  name !== undefined && operationByName(catalog, name) !== undefined
    ? Effect.succeed(name)
    : FlowAborted.make({
        message: `unknown operation ${name ?? "(none)"}; one of: ${catalog.operations.map((operation) => operation.name).join(", ")}`
      })

const program = Effect.gen(function* () {
  const flags = yield* parseSampleFlags(process.argv.slice(2))
  const input = yield* resolveFlowInput("list", flags.rest)
  const [command = "list", ...args] = input.prompt.trim().split(/\s+/)
  const environment = process.env
  const reasoner =
    command === "propose"
      ? coderFor((environment.LLM4TS_REASONER ?? "claude").trim() || "claude")
      : undefined
  if (command === "propose" && reasoner === undefined) {
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
        const service = yield* pickService(workspace, environment.LLM4TS_SOAP_SERVICE?.trim())
        const catalog = yield* loadCatalog(workspace, service)
        const operations = yield* loadOperationsFile(workspace, service)

        switch (command) {
          case "list": {
            const exchanges = yield* readExchanges(workspace, service)
            for (const operation of catalog.operations) {
              const requests = yield* listRequests(workspace, service, operation.name)
              const recorded = exchanges.filter((exchange) => exchange.operation === operation.name)
              const faults = recorded.filter((exchange) => exchange.fault !== undefined).length
              const breaking = recorded.filter(
                (exchange) => exchange.responseIssues.length > 0
              ).length
              yield* say(
                `${operation.name} [${effectiveClass(operations, operation.name)}]: ${requests.length} requests${requests.length === 0 ? "" : ` (${requests.join(", ")})`}, ${recorded.length} exchanges, ${faults} faults, ${breaking} schema findings`
              )
            }
            if (operations?.confirmed !== true) {
              yield* say(`operations.md is not confirmed: nothing can be called yet`)
            }
            return
          }
          case "init": {
            const operation = yield* requireOperation(catalog, args[0])
            const name = args[1] ?? "happy-path"
            if (!isSampleName(name)) {
              return yield* FlowAborted.make({ message: `request names are kebab-case: ${name}` })
            }
            const paths = samplePaths(service, operation, name)
            if (
              (yield* readIfPresent(workspace, paths.yaml)) !== undefined ||
              (yield* readIfPresent(workspace, paths.xml)) !== undefined
            ) {
              return yield* FlowAborted.make({
                message: `${operation}/${name} exists; edit it or pick another name`
              })
            }
            const seeds = yield* seedsForService(workspace, catalog, service)
            yield* workspace.write(
              paths.yaml,
              renderRequestFile({ catalog, operation, purpose: name.replace(/-/g, " "), seeds })
            )
            yield* say(
              `wrote ${paths.yaml}; edit it, then: soap-sample "call ${operation}/${name}"`
            )
            return
          }
          case "propose": {
            const operation = yield* requireOperation(catalog, args[0])
            const seeds = yield* seedsForService(workspace, catalog, service)
            const written = yield* proposeScenarios({
              reasoning: context.reasoning,
              workspace,
              catalog,
              service,
              operation,
              operationClass: effectiveClass(operations, operation),
              seeds
            })
            for (const scenario of written) {
              yield* say(
                scenario.kept
                  ? `kept existing ${scenario.path}`
                  : `wrote ${scenario.path}${scenario.issues.length === 0 ? "" : ` (${scenario.issues.length} problems to fix, listed in the file)`}`
              )
            }
            return
          }
          case "import": {
            const file = args.join(" ")
            if (file === "")
              return yield* FlowAborted.make({
                message: `import needs a SoapUI project path\n${usage}`
              })
            const project = yield* Effect.tryPromise({
              try: () => readFile(resolve(input.workspace, file), "utf8"),
              catch: () => FlowAborted.make({ message: `cannot read ${file}` })
            })
            const key = yield* loadMaskingKey(workspace, service)
            const overrides = yield* loadMaskingOverrides(workspace, service)
            const report = yield* importSoapUiProject({
              workspace,
              catalog,
              service,
              project,
              key,
              ...(overrides === undefined ? {} : { overrides })
            })
            for (const request of report.requests) {
              yield* say(
                `request ${request.path}${request.issues.length === 0 ? "" : ` (${request.issues.length} problems, listed in the file)`}`
              )
            }
            for (const response of report.responses) yield* say(`exchange ${response.path}`)
            for (const line of report.skipped) yield* say(`skipped: ${line}`)
            if (report.credentialsIgnored > 0) {
              yield* say(
                `${report.credentialsIgnored} stored credentials in the project were ignored; put references in auth.json instead`
              )
            }
            yield* say(
              `masked ${report.masking.entries.reduce((sum, entry) => sum + entry.count, 0)} values`
            )
            return
          }
          case "call": {
            const target = args[0] ?? ""
            const profile = yield* loadAuthProfile(workspace, service)
            const stub = environment.LLM4TS_SOAP_STUB?.trim()
            const transport =
              stub === undefined || stub === ""
                ? makeNodeSoapTransport()
                : makeDirectoryStubTransport(resolve(input.workspace, stub), catalog)
            if (stub !== undefined && stub !== "")
              yield* say(`LLM4TS_SOAP_STUB: answering from ${stub}, not the network`)
            const targets: Array<readonly [string, string]> = []
            const operationNames =
              target === "all"
                ? catalog.operations.map((operation) => operation.name)
                : [yield* requireOperation(catalog, target.split("/")[0])]
            for (const operation of operationNames) {
              const names = target.includes("/")
                ? [target.split("/")[1] ?? ""]
                : yield* listRequests(workspace, service, operation)
              for (const name of names) targets.push([operation, name])
            }
            if (targets.length === 0)
              return yield* FlowAborted.make({
                message: `no requests for ${target}; start with soap-sample "init ${target}"`
              })
            const confirm = (question: string) =>
              process.stdin.isTTY === true
                ? terminalInteraction.ask(question).pipe(
                    Effect.map((answer) => /^(y|yes|s|si|sì)$/i.test(answer.trim())),
                    Effect.orElseSucceed(() => false)
                  )
                : Effect.succeed(false)
            let failures = 0
            for (const [operation, name] of targets) {
              const outcome = yield* callOperation({
                workspace,
                catalog,
                service,
                operation,
                name,
                profile,
                operations,
                secrets: nodeSecretSource(environment),
                transport,
                allowMutating: flags.allowMutating,
                confirm,
                keepRaw: flags.keepRaw
              }).pipe(Effect.result)
              if (outcome._tag === "Failure") {
                failures++
                yield* say(`${operation}/${name}: ${outcome.failure.message}`)
                continue
              }
              const { exchange } = outcome.success
              const status =
                exchange.fault !== undefined
                  ? `fault ${exchange.fault.code} ${exchange.fault.reason}`
                  : `HTTP ${exchange.response?.status ?? "?"}`
              yield* say(
                `${operation}/${name}: ${status}, ${exchange.response?.elapsedMs ?? 0} ms, ${exchange.responseIssues.length} schema findings, ${exchange.masking.entries.reduce((sum, entry) => sum + entry.count, 0)} values masked → ${outcome.success.path}`
              )
            }
            if (failures > 0)
              return yield* FlowAborted.make({
                message: `${failures} of ${targets.length} calls did not complete`
              })
            return
          }
          default:
            return yield* FlowAborted.make({ message: `unknown command ${command}\n${usage}` })
        }
      })
  )
})

runFlowMain(program)
