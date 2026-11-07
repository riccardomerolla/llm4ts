import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { redactText } from "@llm4ts/core/observability/Redaction"
import { nodeSecretSource, resolveSide } from "../endpoint/Auth.ts"
import { loadEndpointProfile } from "../endpoint/Endpoints.ts"
import { SoapTransport, displayUrl } from "../endpoint/Transport.ts"
import { PlainFileStore } from "../Persistence.ts"
import { ToolContext, ToolError, defineTool, report } from "./Tool.ts"

const name = "http-call"

const Input = Schema.Struct({
  endpoint: Schema.String,
  env: Schema.optionalKey(Schema.String),
  path: Schema.String,
  expect: Schema.Int,
  timeout: Schema.Int
})

const previewChars = 2_000

/**
 * A GET against a named endpoint (ADR 0048): the profile supplies the base
 * URL, auth, TLS and proxy; the tool adds a path, checks the status and
 * returns a redacted preview of the body. Read-and-probe only: no other
 * method, no request body.
 */
export const httpCall = defineTool({
  name,
  purpose:
    "GET a path of a named endpoint (.llm4ts/endpoints/<name>/auth.<env>.json) and report the status and a redacted body preview",
  args: {
    endpoint: {
      description: "Endpoint name under .llm4ts/endpoints/",
      kind: "string",
      required: true
    },
    env: {
      description: "Environment whose profile to use (dev, test, uat); default auth.json",
      kind: "string"
    },
    path: {
      description: "Path and query appended to the endpoint URL",
      kind: "string",
      default: "/"
    },
    expect: {
      description: "The exact status expected; 0 accepts any 2xx",
      kind: "integer",
      default: "0"
    },
    timeout: { description: "Seconds to wait for the response", kind: "integer", default: "30" }
  },
  input: Input,
  run: (input) =>
    Effect.gen(function* () {
      const context = yield* ToolContext
      const files = yield* PlainFileStore
      const transport = yield* SoapTransport
      const fail = (message: string) => new ToolError({ tool: name, message })
      const profile = yield* loadEndpointProfile(
        files,
        context.projectRoot,
        input.endpoint,
        input.env
      ).pipe(Effect.mapError((error) => fail(error.message)))
      if (profile.endpoint === undefined) {
        return yield* fail(`endpoint ${input.endpoint} has no "endpoint" URL in its profile`)
      }
      const url = yield* Effect.try({
        try: () => new URL(input.path, profile.endpoint).toString(),
        catch: () => fail(`cannot resolve path '${input.path}' against ${profile.endpoint}`)
      })
      const side = yield* resolveSide(
        nodeSecretSource(context.environment),
        profile.call ?? profile.fetch
      ).pipe(Effect.mapError((error) => fail(error.message)))
      const timeout = Duration.seconds(
        input.timeout > 0 ? input.timeout : (profile.timeoutSeconds ?? 30)
      )
      const response = yield* transport
        .send({
          method: "GET",
          url,
          headers: { accept: "application/json, text/*, */*" },
          secretHeaders: side.headers,
          ...(side.tls === undefined ? {} : { tls: side.tls }),
          ...(side.proxy === undefined ? {} : { proxy: side.proxy }),
          timeout
        })
        .pipe(
          Effect.mapError((error) => fail(`${displayUrl(url)}: ${error.reason}: ${error.detail}`))
        )
      const secrets = side.headers.map(([, value]) => Redacted.value(value))
      const body = new TextDecoder("utf8", { fatal: false }).decode(response.body)
      const preview = redactText(body.slice(0, previewChars), { secrets })
      const expected =
        input.expect > 0
          ? response.status === input.expect
          : response.status >= 200 && response.status < 300
      const issues = expected
        ? []
        : [
            {
              path: displayUrl(url),
              detail: `expected ${input.expect > 0 ? `status ${input.expect}` : "a 2xx status"}, got ${response.status}`
            }
          ]
      return report(
        name,
        issues,
        `${displayUrl(url)} answered ${response.status} in ${response.elapsedMs} ms`,
        {
          status: response.status,
          elapsedMs: response.elapsedMs,
          contentType: response.headers["content-type"] ?? null,
          bodyChars: body.length,
          bodyPreview: preview
        }
      )
    })
})
