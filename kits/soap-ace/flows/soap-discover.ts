// Discover a SOAP service: typed catalog of operations and types from its WSDL, open questions, and proposed read/mutating classes; no LLM unless a judgment seat is set.
//
// The task text is the WSDL location, a path (relative to the launch
// directory) or an http(s) URL:
//
//   llm4ts run soap-discover --repo ~/work/conti-api ./wsdl/DemoBank.wsdl
//
// Writes under <repo>/.llm4ts/soap/<service>/:
//
//   catalog.json    the typed catalog every later soap-* step reads
//   catalog.md      a human summary: endpoints, operations, fields, open questions
//   operations.md   proposed read/mutating classes; review, then set
//                   `Status: confirmed`. An existing file is kept as is.
//
// The catalog is read by code (document/literal SOAP 1.1/1.2 bindings, WSDL
// 1.1 and 2.0); anything it does not model is an open question, never a
// guess. Classes are proposed by a name heuristic and, when
// LLM4TS_JUDGMENT_PROVIDER names a judgment seat, by a typed judgment.
// LLM4TS_SOAP_SERVICE overrides the service directory name.
import { isAbsolute, resolve } from "node:path"
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
import { judgmentConnectorFromEnvironment } from "@llm4ts/runner/Connectors"
import { discoverService } from "./lib/soap/Discover.ts"
import { DocumentLoader, makeFileDocumentLoader } from "./lib/soap/Wsdl.ts"

const isUrl = (location: string): boolean => /^https?:\/\//i.test(location)

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput()
  const raw = input.prompt.trim()
  const location = isUrl(raw) || isAbsolute(raw) ? raw : resolve(input.workspace, raw)
  const judgment = yield* judgmentConnectorFromEnvironment()
  const service = process.env.LLM4TS_SOAP_SERVICE?.trim()

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      // Discovery is deterministic; the mock seat only satisfies the context shape.
      coder: mock,
      ...(judgment === undefined ? {} : { judgment }),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        if (isUrl(location)) {
          return yield* FlowAborted.make({
            message:
              "WSDL URLs are read through the SOAP transport and its auth profile, which is not wired yet; download the WSDL and its schemas and pass the local path"
          })
        }
        const workspace = yield* makeNodeWorkspace(input.workDir)
        const result = yield* discoverService({
          workspace,
          location,
          ...(service === undefined || service === "" ? {} : { service }),
          ...(judgment === undefined || context.judgment === undefined
            ? {}
            : { judgment: context.judgment })
        }).pipe(Effect.provideService(DocumentLoader, makeFileDocumentLoader()))

        const { catalog } = result
        yield* say(
          `${result.service}: ${catalog.operations.length} operations, ${catalog.endpoints.length} endpoints, ${catalog.documents.length} documents, ${catalog.openQuestions.length} open questions`
        )
        for (const question of catalog.openQuestions) {
          yield* say(`  open question [${question.code}] ${question.subject}: ${question.detail}`)
        }
        if (result.proposals !== undefined) {
          const count = (kind: string) =>
            result.proposals?.filter((proposal) => proposal.proposed === kind).length ?? 0
          yield* say(
            `proposed classes: ${count("read")} read, ${count("mutating")} mutating, ${count("unclassified")} unclassified — review ${result.paths.operations} and set Status: confirmed`
          )
        } else if (result.existing !== undefined) {
          yield* say(
            `kept ${result.paths.operations} (${result.existing.confirmed ? "confirmed" : "still proposed"})`
          )
          if (result.drift.missing.length > 0) {
            yield* say(
              `  not classified there (treated as unclassified): ${result.drift.missing.join(", ")}`
            )
          }
          if (result.drift.unknown.length > 0) {
            yield* say(`  no longer in the WSDL: ${result.drift.unknown.join(", ")}`)
          }
        }
        yield* say(`wrote ${result.paths.catalog} and ${result.paths.summary}`)
      })
  )
})

runFlowMain(program)
