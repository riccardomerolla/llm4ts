import { readFile } from "node:fs/promises"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

// The auth profile, `.llm4ts/soap/<service>/auth.json` (gitignored). It holds
// references only — `env:NAME` or `file:path` — never a secret value; a
// literal where a secret belongs is a decode error. References are resolved
// at call time into `Redacted` values that live inside the transport; no
// secret reaches arguments, logs, traces, persisted files, or error
// messages (errors name the reference, never its value).

export const Environment = Schema.Literals(["dev", "test", "uat"])
export type Environment = typeof Environment.Type

/** `env:NAME` or `file:path`. */
export const SecretRef = Schema.String.check(
  Schema.isPattern(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/, {
    message: "must be a reference, env:NAME or file:path — never the secret itself"
  })
)

/** A username may be written literally or referenced. */
export const Principal = Schema.String

export class BasicAuth extends Schema.Class<BasicAuth>("BasicAuth")({
  scheme: Schema.Literal("basic"),
  user: Principal,
  password: SecretRef
}) {}

export class BearerAuth extends Schema.Class<BearerAuth>("BearerAuth")({
  scheme: Schema.Literal("bearer"),
  token: SecretRef
}) {}

export class NoAuth extends Schema.Class<NoAuth>("NoAuth")({
  scheme: Schema.Literal("none")
}) {}

export const HttpAuth = Schema.Union([NoAuth, BasicAuth, BearerAuth])
export type HttpAuth = typeof HttpAuth.Type

/** Client TLS: PEM cert+key, or a PKCS#12 bundle; an optional CA bundle. */
export class TlsConfig extends Schema.Class<TlsConfig>("TlsConfig")({
  cert: Schema.optionalKey(SecretRef),
  key: Schema.optionalKey(SecretRef),
  pfx: Schema.optionalKey(SecretRef),
  passphrase: Schema.optionalKey(SecretRef),
  ca: Schema.optionalKey(SecretRef)
}) {}

export class HttpSide extends Schema.Class<HttpSide>("HttpSide")({
  auth: Schema.optionalKey(HttpAuth),
  tls: Schema.optionalKey(TlsConfig)
}) {}

export class UsernameToken extends Schema.Class<UsernameToken>("UsernameToken")({
  user: Principal,
  password: SecretRef,
  passwordType: Schema.Literals(["text", "digest"])
}) {}

export const MutatingPolicy = Schema.Literals(["confirm", "flag", "deny"])
export type MutatingPolicy = typeof MutatingPolicy.Type

export class MutatingPolicies extends Schema.Class<MutatingPolicies>("MutatingPolicies")({
  dev: Schema.optionalKey(MutatingPolicy),
  test: Schema.optionalKey(MutatingPolicy),
  uat: Schema.optionalKey(MutatingPolicy)
}) {}

export class AuthProfile extends Schema.Class<AuthProfile>("AuthProfile")({
  environment: Environment,
  /** Overrides the WSDL's address for calls (the WSDL often names another environment). */
  endpoint: Schema.optionalKey(Schema.String),
  /** Fetching the WSDL and its schemas. */
  fetch: Schema.optionalKey(HttpSide),
  /** Calling operations. */
  call: Schema.optionalKey(HttpSide),
  wsSecurity: Schema.optionalKey(UsernameToken),
  mutating: Schema.optionalKey(MutatingPolicies),
  timeoutSeconds: Schema.optionalKey(Schema.Int)
}) {}

export const defaultMutatingPolicy = (environment: Environment): MutatingPolicy =>
  environment === "dev" ? "confirm" : "flag"

export const mutatingPolicy = (profile: AuthProfile): MutatingPolicy =>
  profile.mutating?.[profile.environment] ?? defaultMutatingPolicy(profile.environment)

export class AuthProfileError extends Schema.TaggedError<AuthProfileError>()("AuthProfileError", {
  /** The reference or field involved; never a secret value. */
  subject: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `auth profile: ${this.subject}: ${this.detail}`
  }
}

export const decodeAuthProfile = (text: string): Effect.Effect<AuthProfile, AuthProfileError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AuthProfile))(text).pipe(
    Effect.mapError(
      (error) =>
        // Schema issues quote the offending input; a mistyped secret could be
        // in it, so only the paths of the issue are kept.
        new AuthProfileError({
          subject: "auth.json",
          detail: `invalid profile (${issuePaths(error.message)})`
        })
    )
  )

/** Keep only the `at ["a"]["b"]` locations of a schema message, dropping any quoted value. */
const issuePaths = (message: string): string => {
  const paths = [...message.matchAll(/at ((?:\[[^\]]*\])+)/g)].map((match) =>
    [...(match[1] ?? "").matchAll(/\["?([^"\]]*)"?\]/g)].map((part) => part[1] ?? "").join(".")
  )
  return paths.length === 0
    ? "see the soap-ace README for the profile shape"
    : `at ${[...new Set(paths)].join(", ")}; secrets must be env:NAME or file:path references`
}

// ---------------------------------------------------------------------------
// Resolution

export interface SecretSource {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, AuthProfileError>
}

export const resolveSecret = (
  source: SecretSource,
  reference: string
): Effect.Effect<Redacted.Redacted<Uint8Array>, AuthProfileError> => {
  if (reference.startsWith("env:")) {
    const name = reference.slice(4)
    const value = source.environment[name]
    return value === undefined || value === ""
      ? Effect.fail(new AuthProfileError({ subject: reference, detail: "variable is not set" }))
      : Effect.succeed(Redacted.make(new TextEncoder().encode(value)))
  }
  if (reference.startsWith("file:")) {
    return Effect.map(source.readFile(reference.slice(5)), (bytes) => Redacted.make(bytes))
  }
  return Effect.fail(new AuthProfileError({ subject: "reference", detail: "not env: or file:" }))
}

export const resolveText = (
  source: SecretSource,
  reference: string
): Effect.Effect<Redacted.Redacted<string>, AuthProfileError> =>
  Effect.map(resolveSecret(source, reference), (secret) =>
    Redacted.make(new TextDecoder().decode(Redacted.value(secret)).replace(/\r?\n$/, ""))
  )

/** A principal: resolved when it is a reference, else the literal. */
export const resolvePrincipal = (
  source: SecretSource,
  value: string
): Effect.Effect<string, AuthProfileError> =>
  value.startsWith("env:") || value.startsWith("file:")
    ? Effect.map(resolveText(source, value), Redacted.value)
    : Effect.succeed(value)

export interface ResolvedTls {
  readonly cert?: Redacted.Redacted<Uint8Array>
  readonly key?: Redacted.Redacted<Uint8Array>
  readonly pfx?: Redacted.Redacted<Uint8Array>
  readonly passphrase?: Redacted.Redacted<string>
  readonly ca?: Redacted.Redacted<Uint8Array>
}

export interface ResolvedSide {
  /** Header name → value to send; values are secrets. */
  readonly headers: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>
  readonly tls: ResolvedTls | undefined
}

const optionalSecret = <K extends string>(
  source: SecretSource,
  name: K,
  reference: string | undefined
) =>
  reference === undefined
    ? Effect.succeed({})
    : Effect.map(resolveSecret(source, reference), (value) => ({ [name]: value }))

export const resolveTls = (
  source: SecretSource,
  tls: TlsConfig | undefined
): Effect.Effect<ResolvedTls | undefined, AuthProfileError> =>
  tls === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        if (tls.pfx !== undefined && (tls.cert !== undefined || tls.key !== undefined)) {
          return yield* new AuthProfileError({
            subject: "tls",
            detail: "use either pfx or cert+key, not both"
          })
        }
        if ((tls.cert === undefined) !== (tls.key === undefined)) {
          return yield* new AuthProfileError({
            subject: "tls",
            detail: "cert and key go together"
          })
        }
        const cert = yield* optionalSecret(source, "cert", tls.cert)
        const key = yield* optionalSecret(source, "key", tls.key)
        const pfx = yield* optionalSecret(source, "pfx", tls.pfx)
        const ca = yield* optionalSecret(source, "ca", tls.ca)
        const passphrase =
          tls.passphrase === undefined
            ? {}
            : { passphrase: yield* resolveText(source, tls.passphrase) }
        return { ...cert, ...key, ...pfx, ...ca, ...passphrase }
      })

const basicHeader = (
  user: string,
  password: Redacted.Redacted<string>
): Redacted.Redacted<string> =>
  Redacted.make(
    `Basic ${Buffer.from(`${user}:${Redacted.value(password)}`, "utf8").toString("base64")}`
  )

export const resolveSide = (
  source: SecretSource,
  side: HttpSide | undefined
): Effect.Effect<ResolvedSide, AuthProfileError> =>
  Effect.gen(function* () {
    const auth = side?.auth
    const tls = yield* resolveTls(source, side?.tls)
    if (auth === undefined || auth.scheme === "none") return { headers: [], tls }
    if (auth.scheme === "basic") {
      const user = yield* resolvePrincipal(source, auth.user)
      const password = yield* resolveText(source, auth.password)
      return { headers: [["authorization", basicHeader(user, password)]], tls }
    }
    const token = yield* resolveText(source, auth.token)
    return {
      headers: [["authorization", Redacted.make(`Bearer ${Redacted.value(token)}`)]],
      tls
    }
  })

export interface ResolvedUsernameToken {
  readonly user: string
  readonly password: Redacted.Redacted<string>
  readonly passwordType: "text" | "digest"
}

export const resolveUsernameToken = (
  source: SecretSource,
  token: UsernameToken | undefined
): Effect.Effect<ResolvedUsernameToken | undefined, AuthProfileError> =>
  token === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        return {
          user: yield* resolvePrincipal(source, token.user),
          password: yield* resolveText(source, token.password),
          passwordType: token.passwordType
        }
      })

/** Secrets from the process environment and local files. */
export const nodeSecretSource = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): SecretSource => ({
  environment,
  readFile: (path) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await readFile(path)),
      catch: () => new AuthProfileError({ subject: `file:${path}`, detail: "not readable" })
    })
})
