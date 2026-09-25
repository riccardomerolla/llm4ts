import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { decodeAuthProfile } from "../flows/lib/soap/Auth.ts"
import { checkCall } from "../flows/lib/soap/CallPolicy.ts"
import type { OperationClass } from "../flows/lib/soap/Classification.ts"

const check = (
  environment: string,
  operationClass: OperationClass,
  allowMutating: string | undefined,
  answer = false,
  extra: Record<string, unknown> = {}
) =>
  Effect.flatMap(decodeAuthProfile(JSON.stringify({ environment, ...extra })), (profile) =>
    checkCall({
      operation: "inserisciBonifico",
      operationClass,
      profile,
      allowMutating,
      confirm: () => Effect.succeed(answer)
    })
  )

describe("call policy", () => {
  it.effect("allows reads and refuses unclassified operations everywhere", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* check("uat", "read", undefined)).operationClass, "read")
      const refused = yield* Effect.flip(check("dev", "unclassified", "inserisciBonifico", true))
      assert.strictEqual(refused._tag, "CallRefused")
      assert.include(refused.message, "operations.md")
    })
  )

  it.effect("asks in dev, needs the exact flag in test and uat", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* check("dev", "mutating", undefined, true)).allowedBy,
        "confirmation"
      )
      assert.strictEqual(
        (yield* Effect.flip(check("dev", "mutating", undefined, false)))._tag,
        "CallRefused"
      )
      assert.strictEqual((yield* check("test", "mutating", "inserisciBonifico")).allowedBy, "flag")
      const wrong = yield* Effect.flip(check("uat", "mutating", "confermaBonifico", true))
      assert.include(wrong.message, "--allow-mutating inserisciBonifico")
    })
  )

  it.effect("refuses wildcards and honours profile overrides", () =>
    Effect.gen(function* () {
      const wildcard = yield* Effect.flip(check("test", "mutating", "*"))
      assert.include(wildcard.message, "no wildcards")
      const denied = yield* Effect.flip(
        check("dev", "mutating", "inserisciBonifico", true, { mutating: { dev: "deny" } })
      )
      assert.include(denied.message, "denied in dev")
    })
  )
})
