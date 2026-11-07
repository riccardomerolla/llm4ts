// Call one prepared sample request of a discovered SOAP service and report
// the outcome: `llm4ts tool soap-call --service <name> --operation <op>
// --request <sample>` (ADR 0048). Reads what soap-discover and soap-sample
// wrote under <project>/.llm4ts/soap/<service>/ — the catalog, the
// operations file, the auth profile, the sample request — and goes through
// the same call policy: an unclassified or mutating operation is refused
// (there is no --allow-mutating here), the request is validated before it
// is sent, the exchange is masked and written beside the sample as always.
import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { nodeSecretSource } from "@llm4ts/flow/endpoint/Auth"
import { SoapTransport } from "@llm4ts/flow/endpoint/Transport"
import { ToolContext, ToolError, defineTool, report } from "@llm4ts/flow/tools/Tool"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { runToolMain } from "@llm4ts/runner/ToolMain"
import { callOperation } from "../flows/lib/soap/Call.ts"
import {
  loadAuthProfile,
  loadCatalog,
  loadOperationsFile,
  profilePath
} from "../flows/lib/soap/Discover.ts"
import { makeDirectoryStubTransport } from "../flows/lib/soap/Stub.ts"
import { makeTokenSource } from "../flows/lib/soap/Sts.ts"

const name = "soap-call"

const Input = Schema.Struct({
  service: Schema.String,
  operation: Schema.String,
  request: Schema.String,
  env: Schema.optionalKey(Schema.String)
})

export const soapCall = defineTool({
  name,
  purpose:
    "Call one prepared sample request of a discovered SOAP service (read operations only) and report the status, fault and schema findings",
  args: {
    service: {
      description: "Service name under .llm4ts/soap/ (from soap-discover)",
      kind: "string",
      required: true
    },
    operation: {
      description: "Operation name in the service catalog",
      kind: "string",
      required: true
    },
    request: {
      description: "Sample request name under samples/<operation>/ (from soap-sample init)",
      kind: "string",
      required: true
    },
    env: {
      description: "Environment whose auth profile to use (dev, test, uat); default auth.json",
      kind: "string"
    }
  },
  input: Input,
  run: (input) =>
    Effect.gen(function* () {
      const context = yield* ToolContext
      const live = yield* SoapTransport
      const fail = (message: string) => new ToolError({ tool: name, message })
      // Each name becomes a path segment under .llm4ts/soap/: one plain word each.
      for (const [field, value] of [
        ["service", input.service],
        ["operation", input.operation],
        ["request", input.request],
        ["env", input.env ?? "dev"]
      ] as const) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value) || value.includes("..")) {
          return yield* fail(`--${field} '${value}' is not a plain name`)
        }
      }
      const workspace = yield* makeNodeWorkspace(context.projectRoot).pipe(
        Effect.mapError((error) => fail(error.message))
      )
      const catalog = yield* loadCatalog(workspace, input.service).pipe(
        Effect.mapError(() =>
          fail(`no catalog for service '${input.service}'; run soap-discover first`)
        )
      )
      const operations = yield* loadOperationsFile(workspace, input.service).pipe(
        Effect.mapError((error) => fail(error.message))
      )
      const profile = yield* loadAuthProfile(workspace, input.service, input.env).pipe(
        Effect.mapError((error) => fail(error.message))
      )
      if (profile === undefined) {
        return yield* fail(`no profile at ${profilePath(input.service, input.env)}`)
      }
      // `LLM4TS_SOAP_STUB=<dir>` answers from recorded responses, as soap-sample does.
      const stub = context.environment.LLM4TS_SOAP_STUB?.trim()
      const transport =
        stub === undefined || stub === ""
          ? live
          : makeDirectoryStubTransport(resolve(context.projectRoot, stub), catalog)
      const secrets = nodeSecretSource(context.environment)
      const token =
        profile.sts === undefined
          ? undefined
          : yield* makeTokenSource({
              workspace,
              service: input.service,
              config: profile.sts,
              secrets,
              transport
            })
      const outcome = yield* callOperation({
        workspace,
        catalog,
        service: input.service,
        operation: input.operation,
        name: input.request,
        profile,
        operations,
        secrets,
        transport,
        ...(token === undefined ? {} : { token }),
        allowMutating: undefined,
        confirm: () => Effect.succeed(false)
      }).pipe(Effect.result)
      if (outcome._tag === "Failure") {
        const failure = outcome.failure
        if (failure._tag === "RequestInvalid") {
          return report(
            name,
            failure.issues.map((issue) => ({
              path: `request ${issue.path}`,
              detail: issue.detail
            })),
            ""
          )
        }
        if (failure._tag === "CallRefused") {
          return report(name, [{ path: input.operation, detail: `refused: ${failure.detail}` }], "")
        }
        return yield* fail(failure.message)
      }
      const { exchange, path } = outcome.success
      const issues = [
        ...(exchange.fault === undefined
          ? []
          : [
              {
                path: input.operation,
                detail: `fault ${exchange.fault.code}: ${exchange.fault.reason}`
              }
            ]),
        ...exchange.responseIssues.map((issue) => ({
          path: `response ${issue.path}`,
          detail: issue.detail
        }))
      ]
      const status = exchange.response?.status
      return report(
        name,
        issues,
        `${input.operation}/${input.request} answered ${status ?? "?"} in ${exchange.response?.elapsedMs ?? 0} ms; exchange at ${path}`,
        {
          status: status ?? null,
          elapsedMs: exchange.response?.elapsedMs ?? null,
          exchange: path,
          masked: exchange.masking.entries.reduce((sum, entry) => sum + entry.count, 0)
        }
      )
    })
})

runToolMain(soapCall)
