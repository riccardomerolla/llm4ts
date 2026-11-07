import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PlainFileStoreShape } from "../Persistence.ts"
import type { AuthProfile, AuthProfileError } from "./Auth.ts"
import { decodeAuthProfile, profileFileName } from "./Auth.ts"

/**
 * Named endpoints (ADR 0048, 3.2): `<project>/.llm4ts/endpoints/<name>/auth.json`,
 * or `auth.<env>.json`, in the same shape as a SOAP service profile — the
 * `endpoint` URL, a `call` side (auth, tls, proxy), optional `fetch`,
 * `mutating`, `timeoutSeconds`. A tool is given a name and an environment,
 * never a token: secrets stay `env:NAME` or `file:path` references.
 */
export const endpointProfilePath = (
  projectRoot: string,
  name: string,
  env: string | undefined
): string => `${projectRoot}/.llm4ts/endpoints/${name}/${profileFileName(env)}`

export class EndpointError extends Schema.TaggedError<EndpointError>()("EndpointError", {
  endpoint: Schema.String,
  message: Schema.String
}) {}

const endpointNamePattern = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/iu

export const loadEndpointProfile = (
  files: PlainFileStoreShape,
  projectRoot: string,
  name: string,
  env: string | undefined
): Effect.Effect<AuthProfile, EndpointError> =>
  Effect.gen(function* () {
    if (!endpointNamePattern.test(name)) {
      return yield* new EndpointError({ endpoint: name, message: "not an endpoint name" })
    }
    const path = endpointProfilePath(projectRoot, name, env)
    const text = yield* files
      .read(path)
      .pipe(
        Effect.mapError((error) => new EndpointError({ endpoint: name, message: error.message }))
      )
    if (text === undefined) {
      return yield* new EndpointError({
        endpoint: name,
        message: `no profile at ${path}; write it with at least {"environment": "dev", "endpoint": "https://…"}`
      })
    }
    return yield* decodeAuthProfile(text, path).pipe(
      Effect.mapError(
        (error: AuthProfileError) => new EndpointError({ endpoint: name, message: error.message })
      )
    )
  })
