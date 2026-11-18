import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  ChatMessage,
  GwsLoginRequired,
  SpaceRef,
  checkGwsVersion,
  gwsVersionRange,
  makeGoogleChatTool,
  maxMessagePages,
  messageCreateArgs,
  messagesListArgs,
  parseMessage,
  parseMessages,
  parseSpaceRef
} from "@llm4ts/flow/GoogleChatTool"

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gws")
const fixture = (name: string): string => readFileSync(path.join(fixtures, name), "utf8")

const space = new SpaceRef({ id: "SPACE1" })
const after = "2026-11-18T10:00:00Z"

const paramsOf = (args: ReadonlyArray<string>, flag: string): unknown => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : JSON.parse(args[index + 1] ?? "")
}

describe("Google Chat tool protocol", () => {
  it("parses space references", () => {
    assert.strictEqual(parseSpaceRef("spaces/AAA")?.id, "AAA")
    assert.strictEqual(parseSpaceRef("AAA")?.id, "AAA")
    assert.strictEqual(parseSpaceRef("AAA")?.name, "spaces/AAA")
    assert.isUndefined(parseSpaceRef("a b"))
    assert.isUndefined(parseSpaceRef("spaces/"))
  })

  it("builds the list argv with a page token only when given", () => {
    const first = messagesListArgs(space, after)
    assert.deepStrictEqual(first.slice(0, 4), ["chat", "spaces", "messages", "list"])
    assert.deepStrictEqual(paramsOf(first, "--params"), {
      parent: "spaces/SPACE1",
      filter: `createTime > "${after}"`,
      orderBy: "createTime ASC",
      pageSize: 100
    })
    assert.isUndefined(paramsOf(first, "--json"))
    assert.deepStrictEqual(paramsOf(messagesListArgs(space, after, "PAGE2"), "--params"), {
      parent: "spaces/SPACE1",
      filter: `createTime > "${after}"`,
      orderBy: "createTime ASC",
      pageSize: 100,
      pageToken: "PAGE2"
    })
  })

  it("builds the create argv, replying in a thread only when given one", () => {
    const threaded = messageCreateArgs(space, "hello", "spaces/SPACE1/threads/T1")
    assert.deepStrictEqual(threaded.slice(0, 4), ["chat", "spaces", "messages", "create"])
    assert.deepStrictEqual(paramsOf(threaded, "--params"), {
      parent: "spaces/SPACE1",
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
    })
    assert.deepStrictEqual(paramsOf(threaded, "--json"), {
      text: "hello",
      thread: { name: "spaces/SPACE1/threads/T1" }
    })

    const top = messageCreateArgs(space, "hello")
    assert.deepStrictEqual(paramsOf(top, "--params"), { parent: "spaces/SPACE1" })
    assert.deepStrictEqual(paramsOf(top, "--json"), { text: "hello" })
  })

  it.effect("decodes the message list fixture into flat messages", () =>
    Effect.gen(function* () {
      const page = yield* parseMessages(fixture("messages-list.json"))
      assert.strictEqual(page.nextPageToken, "PAGE2")
      assert.deepStrictEqual(
        page.messages[0],
        new ChatMessage({
          name: "spaces/SPACE1/messages/MSG1.MSG1",
          createTime: "2026-11-18T10:00:01.123456Z",
          text: "/bot hello",
          senderName: "users/USER1",
          senderType: "HUMAN",
          senderDisplayName: "Owner One",
          threadName: "spaces/SPACE1/threads/MSG1"
        })
      )
      assert.strictEqual(page.messages[1]?.text, "")
      assert.strictEqual(page.messages[2]?.senderType, "BOT")
    })
  )

  it.effect("decodes the created message fixture", () =>
    Effect.gen(function* () {
      const message = yield* parseMessage(fixture("messages-create.json"))
      assert.strictEqual(message.name, "spaces/SPACE1/messages/MSG9.MSG9")
      assert.strictEqual(message.threadName, "spaces/SPACE1/threads/MSG1")
      assert.isUndefined(message.senderDisplayName)
    })
  )

  it.effect("fails malformed JSON as a ProcessError", () =>
    Effect.gen(function* () {
      const listError = yield* Effect.flip(parseMessages("{not json"))
      assert.strictEqual(listError._tag, "Process")
      const messageError = yield* Effect.flip(parseMessage("[]"))
      assert.strictEqual(messageError._tag, "Process")
    })
  )

  it.effect("accepts the recorded version and refuses one outside the range", () =>
    Effect.gen(function* () {
      yield* checkGwsVersion(
        `${fixture("version.txt")}\nThis is not an officially supported product`
      )
      const tooOld = yield* Effect.flip(checkGwsVersion("gws 0.22.4"))
      assert.include(tooOld.detail, gwsVersionRange.min)
      assert.include(tooOld.detail, gwsVersionRange.below)
      const tooNew = yield* Effect.flip(checkGwsVersion(`gws ${gwsVersionRange.below}`))
      assert.include(tooNew.detail, gwsVersionRange.min)
      assert.include(tooNew.detail, gwsVersionRange.below)
    })
  )
})

describe("Google Chat tool", () => {
  it.effect("follows nextPageToken and returns messages oldest first", () =>
    Effect.gen(function* () {
      const secondPage = JSON.stringify({
        messages: [
          {
            name: "spaces/SPACE1/messages/MSG4.MSG4",
            sender: { name: "users/USER1", type: "HUMAN" },
            createTime: "2026-11-18T10:00:12.000000Z",
            text: "/bot status",
            thread: { name: "spaces/SPACE1/threads/MSG4" }
          }
        ]
      })
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messagesListArgs(space, after)]),
            ProcessResult.make({ stdout: [fixture("messages-list.json")], exitCode: 0 })
          ],
          [
            processCommandKey(["gws", ...messagesListArgs(space, after, "PAGE2")]),
            ProcessResult.make({ stdout: [secondPage], exitCode: 0 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const messages = yield* chat.listMessages(space, after)
      assert.deepStrictEqual(
        messages.map((message) => message.name),
        [
          "spaces/SPACE1/messages/MSG1.MSG1",
          "spaces/SPACE1/messages/MSG2.MSG2",
          "spaces/SPACE1/messages/MSG3.MSG3",
          "spaces/SPACE1/messages/MSG4.MSG4"
        ]
      )
      assert.lengthOf(yield* fake.recorded, 2)
    })
  )

  it.effect("creates a message and decodes the reply", () =>
    Effect.gen(function* () {
      const args = messageCreateArgs(space, "hi", "spaces/SPACE1/threads/MSG1")
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...args]),
            ProcessResult.make({ stdout: [fixture("messages-create.json")], exitCode: 0 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const created = yield* chat.createMessage(space, "hi", "spaces/SPACE1/threads/MSG1")
      assert.strictEqual(created.name, "spaces/SPACE1/messages/MSG9.MSG9")
    })
  )

  it.effect("maps a logged-out gws to GwsLoginRequired without its credentials hint", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messagesListArgs(space, after)]),
            ProcessResult.make({
              stdout: fixture("auth-error.json").split("\n"),
              stderr: ["error[auth]: Access denied. No credentials provided."],
              exitCode: 2
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.listMessages(space, after))
      assert.instanceOf(error, GwsLoginRequired)
      assert.strictEqual(error.message, "Google login required. Run: gws auth login")
      assert.notInclude(error.message, "CREDENTIALS")
      assert.notInclude(error.message, "/")
    })
  )

  it.effect("fails any other non-zero exit as a ProcessError", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messageCreateArgs(space, "hi")]),
            ProcessResult.make({
              stdout: ['{"error":{"code":403,"message":"denied","reason":"forbidden"}}'],
              exitCode: 1
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.createMessage(space, "hi"))
      assert.strictEqual(error._tag, "Process")
    })
  )

  it.effect("keeps only gws's error code and reason, never its message text", () =>
    Effect.gen(function* () {
      const secret = "/home/op/.config/gws/credentials.json"
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messageCreateArgs(space, "hi")]),
            ProcessResult.make({
              stdout: [
                JSON.stringify({
                  error: { code: 403, message: `cannot read ${secret}`, reason: "forbidden" }
                })
              ],
              stderr: [`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${secret}`],
              exitCode: 1
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.createMessage(space, "hi"))
      assert.strictEqual(error._tag, "Process")
      const text = JSON.stringify(error)
      assert.notInclude(text, secret)
      assert.notInclude(text, "CREDENTIALS")
      if (error._tag === "Process") assert.strictEqual(error.detail, "gws error 403 forbidden")
    })
  )

  it.effect("says only the exit code when gws's output is not its error envelope", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messageCreateArgs(space, "hi")]),
            ProcessResult.make({
              stdout: ["could not open /home/op/.config/gws/credentials.json"],
              exitCode: 3
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.createMessage(space, "hi"))
      if (error._tag !== "Process") return assert.fail(`unexpected ${error._tag}`)
      assert.strictEqual(error.detail, "exit code 3")
    })
  )

  it.effect("stops listing when a page token repeats", () =>
    Effect.gen(function* () {
      const page = (token: string) => JSON.stringify({ messages: [], nextPageToken: token })
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", ...messagesListArgs(space, after)]),
            ProcessResult.make({ stdout: [page("SAME")], exitCode: 0 })
          ],
          [
            processCommandKey(["gws", ...messagesListArgs(space, after, "SAME")]),
            ProcessResult.make({ stdout: [page("SAME")], exitCode: 0 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.listMessages(space, after))
      if (error._tag !== "Process") return assert.fail(`unexpected ${error._tag}`)
      assert.include(error.detail, "repeated a page token")
      assert.lengthOf(yield* fake.recorded, 2)
    })
  )

  it.effect("stops listing after the page cap", () =>
    Effect.gen(function* () {
      const page = (n: number) => JSON.stringify({ messages: [], nextPageToken: `P${n + 1}` })
      const responses = new Map([
        [
          processCommandKey(["gws", ...messagesListArgs(space, after)]),
          ProcessResult.make({ stdout: [page(1)], exitCode: 0 })
        ]
      ])
      for (let n = 2; n <= maxMessagePages + 5; n++) {
        responses.set(
          processCommandKey(["gws", ...messagesListArgs(space, after, `P${n}`)]),
          ProcessResult.make({ stdout: [page(n)], exitCode: 0 })
        )
      }
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const chat = makeGoogleChatTool(fake.executor, "/repo", events)
      const error = yield* Effect.flip(chat.listMessages(space, after))
      if (error._tag !== "Process") return assert.fail(`unexpected ${error._tag}`)
      assert.include(error.detail, `${maxMessagePages} pages`)
      assert.lengthOf(yield* fake.recorded, maxMessagePages)
    })
  )

  it.effect("probes the installed gws version", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gws", "--version"]),
            ProcessResult.make({
              stdout: [
                fixture("version.txt").trim(),
                "This is not an officially supported product"
              ],
              exitCode: 0
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      yield* makeGoogleChatTool(fake.executor, "/repo", events).probe
    })
  )
})
