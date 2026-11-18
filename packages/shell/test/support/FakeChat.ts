import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { FlowError } from "@llm4ts/flow/FlowError"
import {
  ChatMessage,
  type GoogleChatToolShape,
  type GwsLoginRequired,
  type SpaceRef
} from "@llm4ts/flow/GoogleChatTool"

export const ownerId = "users/owner"

export interface Posted {
  readonly text: string
  readonly threadName: string | undefined
}

export interface FakeChat {
  readonly tool: GoogleChatToolShape
  /** A message someone typed into the space; fields default to the owner, a person. */
  readonly add: (
    text: string,
    fields?: Partial<Omit<ChatMessage, "text" | "createTime">>
  ) => Effect.Effect<ChatMessage>
  /** What the tool posted, oldest first. */
  readonly posted: Effect.Effect<ReadonlyArray<Posted>>
  /** Every call to `listMessages` and `createMessage` fails with this until it is cleared. */
  readonly failWith: (error: FlowError | GwsLoginRequired | undefined) => Effect.Effect<void>
}

const base = Date.parse("2026-11-18T10:00:00.000Z")

/**
 * An in-memory Chat space. The tool posts as the owner, a person, as `gws`
 * does with the owner's login, so only the marker and the posted names tell
 * its messages apart.
 */
export const makeFakeChat = (): Effect.Effect<FakeChat> =>
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<ChatMessage>>([])
    const posted = yield* Ref.make<ReadonlyArray<Posted>>([])
    const failure = yield* Ref.make<FlowError | GwsLoginRequired | undefined>(undefined)
    let tick = 0
    const next = (fields: Omit<ChatMessage, "createTime" | "name"> & { readonly name?: string }) =>
      Effect.gen(function* () {
        tick += 1
        const message = new ChatMessage({
          name: `spaces/AAA/messages/m${tick}`,
          createTime: new Date(base + tick * 1_000).toISOString(),
          ...fields
        })
        yield* Ref.update(messages, (all) => [...all, message])
        return message
      })
    const guard = Effect.gen(function* () {
      const error = yield* Ref.get(failure)
      if (error !== undefined) return yield* Effect.fail(error)
    })
    const tool: GoogleChatToolShape = {
      probe: Effect.void,
      listMessages: (_space: SpaceRef, after: string) =>
        guard.pipe(
          Effect.andThen(Ref.get(messages)),
          Effect.map((all) => all.filter((message) => message.createTime > after))
        ),
      createMessage: (_space: SpaceRef, text: string, threadName?: string) =>
        guard.pipe(
          Effect.andThen(Ref.update(posted, (all) => [...all, { text, threadName }])),
          Effect.andThen(
            next({
              text,
              senderName: ownerId,
              senderType: "HUMAN",
              senderDisplayName: "Owner",
              ...(threadName === undefined ? {} : { threadName })
            })
          )
        )
    }
    return {
      tool,
      add: (text, fields = {}) =>
        next({
          senderName: ownerId,
          senderType: "HUMAN",
          senderDisplayName: "Owner",
          threadName: `spaces/AAA/threads/t${tick + 1}`,
          ...fields,
          text
        }),
      posted: Ref.get(posted),
      failWith: (error) => Ref.set(failure, error)
    }
  })
