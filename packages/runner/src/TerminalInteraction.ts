import { createInterface } from "node:readline/promises"
import { stdin, stderr } from "node:process"
import * as Effect from "effect/Effect"
import { ProcessError } from "@llm4ts/flow/FlowError"
import type { ApprovalPolicy, InteractionShape } from "@llm4ts/flow/Interaction"
import { ApprovalAllowed, ApprovalDenied } from "@llm4ts/flow/Interaction"

export const terminalInteraction: InteractionShape = {
  ask: (question) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        createInterface({
          input: stdin,
          output: stderr
        })
      ),
      (terminal) =>
        Effect.tryPromise({
          try: () => terminal.question(`❓ ${question}\n> `),
          catch: (error) =>
            ProcessError.make({
              message: "terminal input",
              detail: error instanceof Error ? error.message : String(error)
            })
        }),
      (terminal) => Effect.sync(() => terminal.close())
    )
}

export const terminalApprovalPolicy = (
  interaction: InteractionShape = terminalInteraction
): ApprovalPolicy => ({
  decide: (toolName, input) =>
    interaction
      .ask(`Allow tool '${toolName}' with input ${JSON.stringify(input)}? [y/N]`)
      .pipe(
        Effect.map((answer) =>
          /^(y|yes)$/iu.test(answer.trim())
            ? new ApprovalAllowed()
            : ApprovalDenied.make({ reason: "operator denied" })
        )
      )
})
