import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeRoster } from "@llm4ts/flow/Roster"
import { loadRosterDocument } from "@llm4ts/runner/ExecutorRoster"

// The roster in docs/vertex-service-account.md is a shipped example: this
// keeps the guide, the example file and the roster loader in agreement.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const example = readFileSync(join(root, "examples", "vertex", "roster.example.json"), "utf8")
const guide = readFileSync(join(root, "docs", "vertex-service-account.md"), "utf8")

const environment = {
  HOME: "/home/me",
  LLM4TS_ROSTER: "/cfg/roster.json",
  VERTEX_PROJECT: "my-bank-ai",
  VERTEX_KEY_FILE: "/home/me/.config/gcloud/llm4ts-agents.json"
}

const load = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    yield* memory.store.writeAtomic("/cfg/roster.json", example)
    return yield* loadRosterDocument({ files: memory.store, environment: env, workDir: "/repo" })
  })

describe("the Vertex roster of the guide", () => {
  it("the guide shows the example file, unchanged", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(guide)?.[1] ?? ""
    assert.deepStrictEqual(JSON.parse(block), JSON.parse(example))
  })

  it.effect(
    "loads with the two variables set, and leases Gemini coders first, Claude to plan",
    () =>
      Effect.gen(function* () {
        const document = yield* load(environment)
        assert.deepStrictEqual(
          document?.executors.map((executor) => [executor.id, executor.harness]),
          [
            ["claude-vertex", "claude"],
            ["pi-gemini-vertex", "pi"],
            ["opencode-gemini-vertex", "opencode"],
            ["gemini-vertex", "gemini"]
          ]
        )
        const events = yield* makeFlowEventHub()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const roster = yield* makeRoster({ executors: document?.executors ?? [], events })
            const first = (yield* roster.lease("coder")).executor.id
            assert.include(["pi-gemini-vertex", "opencode-gemini-vertex"], first)
            assert.strictEqual((yield* roster.lease("planner")).executor.id, "claude-vertex")
          })
        )
      })
  )

  it.effect("is refused when a referenced variable is not set", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(load({ ...environment, VERTEX_KEY_FILE: undefined }))
      assert.include(error.message, "VERTEX_KEY_FILE")
      assert.include(error.message, "unset variable")
    })
  )

  it("no executor carries a secret: the key is a path held in a variable", () => {
    assert.notInclude(example, "private_key")
    assert.include(example, '"GOOGLE_APPLICATION_CREDENTIALS": "${VERTEX_KEY_FILE}"')
  })
})
