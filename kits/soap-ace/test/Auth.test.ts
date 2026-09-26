import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import {
  AuthProfileError,
  decodeAuthProfile,
  mutatingPolicy,
  resolveSide,
  resolveUsernameToken,
  type SecretSource
} from "../flows/lib/soap/Auth.ts"

const source = (
  environment: Record<string, string>,
  files: Record<string, string> = {}
): SecretSource => ({
  environment,
  readFile: (path) => {
    const found = files[path]
    return found === undefined
      ? Effect.fail(new AuthProfileError({ subject: `file:${path}`, detail: "not readable" }))
      : Effect.succeed(new TextEncoder().encode(found))
  }
})

describe("auth profile", () => {
  it.effect("decodes a profile made of references", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(
        JSON.stringify({
          environment: "uat",
          endpoint: "https://uat.example/soap",
          fetch: { auth: { scheme: "basic", user: "svc-reader", password: "env:WSDL_PASS" } },
          call: {
            auth: { scheme: "bearer", token: "env:SOAP_TOKEN" },
            tls: { pfx: "file:/certs/client.p12", passphrase: "env:P12_PASS" }
          },
          wsSecurity: { user: "env:WS_USER", password: "env:WS_PASS", passwordType: "digest" },
          mutating: { uat: "deny" }
        })
      )
      assert.strictEqual(profile.environment, "uat")
      assert.strictEqual(mutatingPolicy(profile), "deny")
    })
  )

  it.effect("refuses a literal secret without echoing it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeAuthProfile(
          JSON.stringify({
            environment: "dev",
            call: { auth: { scheme: "basic", user: "u", password: "hunter2-SECRET" } }
          })
        )
      )
      assert.notInclude(error.message, "hunter2-SECRET")
      assert.include(error.message, "password")
    })
  )

  it.effect("refuses environments other than dev, test, and uat", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeAuthProfile(JSON.stringify({ environment: "prod" })))
      assert.strictEqual(error._tag, "AuthProfileError")
    })
  )

  it("defaults mutating policy to confirm in dev and flag elsewhere", () =>
    Effect.gen(function* () {
      const dev = yield* decodeAuthProfile('{"environment":"dev"}')
      const test = yield* decodeAuthProfile('{"environment":"test"}')
      assert.strictEqual(mutatingPolicy(dev), "confirm")
      assert.strictEqual(mutatingPolicy(test), "flag")
    }).pipe(Effect.runSync))
})

describe("secret resolution", () => {
  it.effect("builds redacted Basic and Bearer headers from references", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(
        JSON.stringify({
          environment: "dev",
          fetch: { auth: { scheme: "basic", user: "env:U", password: "env:P" } },
          call: { auth: { scheme: "bearer", token: "file:/run/token" } }
        })
      )
      const secrets = source({ U: "alice", P: "s3cret" }, { "/run/token": "tok-123\n" })
      const fetch = yield* resolveSide(secrets, profile.fetch)
      const call = yield* resolveSide(secrets, profile.call)
      const [name, value] = fetch.headers[0] ?? ["", Redacted.make("")]
      assert.strictEqual(name, "authorization")
      assert.strictEqual(
        Redacted.value(value),
        `Basic ${Buffer.from("alice:s3cret").toString("base64")}`
      )
      assert.notInclude(String(value), "s3cret")
      assert.strictEqual(
        Redacted.value(call.headers[0]?.[1] ?? Redacted.make("")),
        "Bearer tok-123"
      )
    })
  )

  it.effect("names the missing reference, never a value", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(
        JSON.stringify({
          environment: "dev",
          call: { auth: { scheme: "basic", user: "u", password: "env:NOT_SET" } }
        })
      )
      const error = yield* Effect.flip(resolveSide(source({}), profile.call))
      assert.strictEqual(error.subject, "env:NOT_SET")
    })
  )

  it.effect("checks TLS combinations", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(
        JSON.stringify({ environment: "dev", call: { tls: { cert: "file:/c.pem" } } })
      )
      const error = yield* Effect.flip(resolveSide(source({}, { "/c.pem": "x" }), profile.call))
      assert.include(error.detail, "cert and key")
    })
  )

  it.effect("resolves a UsernameToken", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(
        JSON.stringify({
          environment: "dev",
          wsSecurity: { user: "svc", password: "env:WS", passwordType: "text" }
        })
      )
      const token = yield* resolveUsernameToken(source({ WS: "pw" }), profile.wsSecurity)
      assert.strictEqual(token?.user, "svc")
      assert.strictEqual(Redacted.value(token?.password ?? Redacted.make("")), "pw")
    })
  )
})
