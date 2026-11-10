import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  configTrustPath,
  contentHash,
  distrustNotice,
  forgetTrust,
  launchRefusal,
  loadTrustStore,
  readTrustStore,
  recordTrust,
  trustDecision,
  writeRefusal,
  type TrustStore
} from "@llm4ts/shell/ConfigTrust"

const repo = "/work/app"
const hash = contentHash("LLM4TS_JUDGE_ROUNDS=1\n")
const loaded = (records: Readonly<Record<string, string>>): TrustStore => ({
  _tag: "Loaded",
  records
})

describe("configTrustPath", () => {
  it("is under XDG_STATE_HOME, else ~/.local/state", () => {
    assert.strictEqual(
      configTrustPath({ HOME: "/home/u", XDG_STATE_HOME: "/state" }),
      "/state/llm4ts/config-trust.json"
    )
    assert.strictEqual(
      configTrustPath({ HOME: "/home/u" }),
      "/home/u/.local/state/llm4ts/config-trust.json"
    )
  })
})

describe("contentHash", () => {
  it("is the SHA-256 of the text, so one byte more is another hash", () => {
    assert.strictEqual(
      contentHash(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
    assert.notStrictEqual(contentHash("LLM4TS_JUDGE_ROUNDS=1"), hash)
  })
})

describe("trustDecision", () => {
  it.each([
    ["this hash for this repository", loaded({ [repo]: hash }), repo, "trusted"],
    ["the repository named with a trailing slash", loaded({ [repo]: hash }), `${repo}/`, "trusted"],
    ["no record", loaded({}), repo, "untrusted"],
    ["another hash for this repository", loaded({ [repo]: contentHash("") }), repo, "changed"],
    ["this hash for another repository", loaded({ "/work/other": hash }), repo, "untrusted"],
    ["the repository moved", loaded({ [repo]: hash }), "/work/moved", "untrusted"],
    ["a folder under the repository", loaded({ [repo]: hash }), `${repo}/packages/a`, "untrusted"],
    ["a path that is an object member, not a record", loaded({}), "constructor", "untrusted"],
    ["a list that cannot be used", { _tag: "Unusable", reason: "x" }, repo, "untrusted"]
  ] as const)("%s", (_label, store, at, expected) => {
    assert.strictEqual(trustDecision(store, at, hash), expected)
  })
})

describe("readTrustStore", () => {
  it("an absent list is empty; a list of another shape cannot be used", () => {
    assert.deepStrictEqual(readTrustStore(undefined), loaded({}))
    assert.deepStrictEqual(
      readTrustStore(JSON.stringify({ [repo]: hash })),
      loaded({ [repo]: hash })
    )
    for (const text of ["", "{ nope", "[]", "null", JSON.stringify({ [repo]: 7 })]) {
      assert.strictEqual(readTrustStore(text)._tag, "Unusable", text)
    }
  })
})

describe("the trust list on disk", () => {
  const path = "/state/llm4ts/config-trust.json"

  it.effect("recording keeps other repositories, replaces this one's hash, and is idempotent", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* recordTrust(memory.store, path, "/work/other", "abc")
      yield* recordTrust(memory.store, path, repo, "old")
      yield* recordTrust(memory.store, path, repo, hash)
      const once = yield* memory.files
      assert.deepStrictEqual(
        yield* loadTrustStore(memory.store, path),
        loaded({ "/work/other": "abc", [repo]: hash })
      )
      yield* recordTrust(memory.store, path, repo, hash)
      assert.deepStrictEqual(yield* memory.files, once)
    })
  )

  it.effect("forgetting removes one record and says whether there was one", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* recordTrust(memory.store, path, "/work/other", "abc")
      yield* recordTrust(memory.store, path, repo, hash)
      assert.isTrue(yield* forgetTrust(memory.store, path, repo))
      assert.isFalse(yield* forgetTrust(memory.store, path, repo))
      assert.deepStrictEqual(
        yield* loadTrustStore(memory.store, path),
        loaded({ "/work/other": "abc" })
      )
    })
  )

  it.effect("a list that cannot be read or decoded is unusable, never a failure", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({ [path]: "{ nope" })
      assert.strictEqual((yield* loadTrustStore(memory.store, path))._tag, "Unusable")
      assert.isFalse(yield* forgetTrust(memory.store, path, repo))
      assert.strictEqual((yield* memory.files)[path], "{ nope")
      const denied = yield* loadTrustStore(
        {
          ...memory.store,
          read: () => Effect.fail(PersistenceError.make({ message: "permission denied" }))
        },
        path
      )
      assert.deepStrictEqual(denied, { _tag: "Unusable", reason: "permission denied" })
    })
  )
})

describe("what an untrusted project file makes llm4ts say", () => {
  const projectPath = `${repo}/.llm4ts/config.env`

  it("names the file, that it was not read, and the one command", () => {
    assert.strictEqual(
      distrustNotice(projectPath, repo, "untrusted"),
      `${projectPath} is new and not trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}`
    )
    assert.strictEqual(
      launchRefusal(projectPath, repo, "changed"),
      `${projectPath} has changed since it was trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo ${repo}\nNothing was started.`
    )
    assert.strictEqual(
      writeRefusal(projectPath, repo, "changed"),
      `${projectPath} has changed since it was trusted, so llm4ts writes nothing to it. Review and accept it first: llm4ts config trust --repo ${repo}`
    )
  })
})
