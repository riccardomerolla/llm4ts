import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type AuthProfile, type MutatingPolicy, mutatingPolicy } from "./Auth.ts"
import type { OperationClass } from "./Classification.ts"

// Whether one operation may be called now. Non-production environments
// still share data and reach other teams' downstream test systems, so the
// guard stays on everywhere:
//
//   unclassified → refused (confirm operations.md first)
//   read         → allowed
//   mutating     → the environment's policy: `confirm` (default in dev)
//                  asks interactively, `flag` (default in test and uat)
//                  needs `--allow-mutating <operation>` naming exactly this
//                  operation, `deny` refuses. Profiles may override per
//                  environment.

export class CallRefused extends Schema.TaggedError<CallRefused>()("CallRefused", {
  operation: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `${this.operation} not called: ${this.detail}`
  }
}

export interface CallRequest {
  readonly operation: string
  readonly operationClass: OperationClass
  readonly profile: AuthProfile
  /** The operation named by `--allow-mutating`, if any (no wildcards). */
  readonly allowMutating: string | undefined
  /** Interactive confirmation; a non-interactive run answers false. */
  readonly confirm: (question: string) => Effect.Effect<boolean>
}

export interface CallPermission {
  readonly operation: string
  readonly operationClass: "read" | "mutating"
  /** How a mutating call was allowed; absent for reads. */
  readonly allowedBy?: "confirmation" | "flag"
}

const refuse = (operation: string, detail: string) =>
  Effect.fail(new CallRefused({ operation, detail }))

export const checkCall = (request: CallRequest): Effect.Effect<CallPermission, CallRefused> => {
  const { operation, operationClass, profile } = request
  if (request.allowMutating !== undefined && /[*?,\s]/.test(request.allowMutating)) {
    return refuse(operation, "--allow-mutating names exactly one operation; no wildcards or lists")
  }
  if (operationClass === "unclassified") {
    return refuse(
      operation,
      "the operation is unclassified; classify it in operations.md and set Status: confirmed"
    )
  }
  if (operationClass === "read") return Effect.succeed({ operation, operationClass })

  const policy: MutatingPolicy = mutatingPolicy(profile)
  const flagged = request.allowMutating === operation
  switch (policy) {
    case "deny":
      return refuse(operation, `mutating calls are denied in ${profile.environment}`)
    case "flag":
      return flagged
        ? Effect.succeed({ operation, operationClass, allowedBy: "flag" })
        : refuse(
            operation,
            `mutating calls in ${profile.environment} need --allow-mutating ${operation}`
          )
    case "confirm":
      if (flagged) return Effect.succeed({ operation, operationClass, allowedBy: "flag" })
      return Effect.flatMap(
        request.confirm(`${operation} changes state in ${profile.environment}. Call it now? [y/N]`),
        (confirmed) =>
          confirmed
            ? Effect.succeed({ operation, operationClass, allowedBy: "confirmation" as const })
            : refuse(operation, "not confirmed")
      )
  }
}
