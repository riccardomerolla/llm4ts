import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ProcessResult, makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  nodePreflight,
  nodePreflightReport,
  nodeVersionSatisfies
} from "@llm4ts/flow/NodePreflight"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

const nodeOnPath = (version: string) =>
  makeFakeProcessExecutor({
    responses: new Map([
      [
        JSON.stringify(["node", "--version"]),
        ProcessResult.make({ exitCode: 0, stdout: [version], stderr: [] })
      ]
    ])
  })

describe("nodeVersionSatisfies", () => {
  it("reads pins the way nvm, engines and corepack write them", () => {
    assert.isTrue(nodeVersionSatisfies("v24.12.0", "24"))
    assert.isTrue(nodeVersionSatisfies("v24.12.0", "v24.12.0\n"))
    assert.isTrue(nodeVersionSatisfies("v24.12.0", "24.x"))
    assert.isFalse(nodeVersionSatisfies("v24.12.0", "20"))
    assert.isFalse(nodeVersionSatisfies("v24.12.0", "20.16.0"))
    assert.isTrue(nodeVersionSatisfies("v24.12.0", ">=22"))
    assert.isFalse(nodeVersionSatisfies("v20.16.0", ">=22"))
    assert.isTrue(nodeVersionSatisfies("v20.16.0", "^20.11.0"))
    assert.isFalse(nodeVersionSatisfies("v21.0.0", "^20.11.0"))
    assert.isTrue(nodeVersionSatisfies("v20.16.0", "~20.16.0"))
    assert.isFalse(nodeVersionSatisfies("v20.17.0", "~20.16.0"))
    assert.isTrue(nodeVersionSatisfies("v22.1.0", "^20.11 || >=22"))
    assert.isTrue(nodeVersionSatisfies("v20.12.0", "^20.11 || >=22"))
    assert.isFalse(nodeVersionSatisfies("v21.5.0", "^20.11 || >=22"))
    assert.isTrue(nodeVersionSatisfies("v20.5.0", ">=18 <21"))
    assert.isTrue(nodeVersionSatisfies("v19.0.0", "18 - 20"))
    assert.isTrue(nodeVersionSatisfies("v19.0.0", "*"))
    // Aliases only a version manager can resolve are unknown, not wrong.
    assert.isUndefined(nodeVersionSatisfies("v24.12.0", "lts/*"))
    assert.isUndefined(nodeVersionSatisfies("v24.12.0", "lts/iron"))
    assert.isUndefined(nodeVersionSatisfies("v24.12.0", "node"))
  })
})

describe("nodePreflightReport", () => {
  it.effect("passes with no pin, and says so", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/package.json", '{"name":"app"}')
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "NoPin")
      assert.deepStrictEqual(yield* fake.recorded, [])
    })
  )

  it.effect("names the pin, its file, and the Node gates would run on when they disagree", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/.nvmrc", "20\n")
      yield* files.store.writeAtomic("/app/package.json", '{"engines":{"node":">=22"}}')
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "Mismatch")
      if (report._tag === "Mismatch") {
        assert.strictEqual(report.node, "v24.12.0")
        assert.deepStrictEqual(
          report.unmet.map((pin) => [pin.spec, pin.source]),
          [["20", ".nvmrc"]]
        )
        assert.include(report.summary, "v24.12.0")
        assert.include(report.summary, ".nvmrc")
        assert.include(report.summary, "use-node-version")
        assert.include(report.summary, "LLM4TS_NODE_CHECK=off")
      }
      const probe = (yield* fake.recorded)[0]
      assert.strictEqual(probe?.cwd, "/app")
    })
  )

  it.effect("passes when every pin holds, listing them", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v22.14.0")
      yield* files.store.writeAtomic("/app/.node-version", "22.14.0")
      yield* files.store.writeAtomic("/app/package.json", '{"engines":{"node":">=22"}}')
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "Ok")
      if (report._tag === "Ok") {
        assert.include(report.summary, "v22.14.0")
        assert.include(report.summary, ".node-version")
        assert.include(report.summary, "engines")
      }
    })
  )

  it.effect("trusts pnpm's use-node-version over whatever is on PATH", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/.nvmrc", "20")
      yield* files.store.writeAtomic("/app/.npmrc", "# pinned\nuse-node-version=20.16.0\n")
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "Managed")
      if (report._tag === "Managed") {
        assert.strictEqual(report.node, "20.16.0")
      }
      assert.deepStrictEqual(yield* fake.recorded, [])
    })
  )

  it.effect("treats an alias pin as unknown rather than failing it", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/.nvmrc", "lts/*")
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "Ok")
      if (report._tag === "Ok") {
        assert.include(report.summary, "lts/*")
        assert.include(report.summary, "not checked")
      }
    })
  )

  it.effect("reports a missing node on PATH", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* makeFakeProcessExecutor()
      yield* files.store.writeAtomic("/app/.nvmrc", "20")
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {})
      assert.strictEqual(report._tag, "NoNode")
    })
  )

  it.effect("is off with LLM4TS_NODE_CHECK=off", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/.nvmrc", "20")
      const report = yield* nodePreflightReport(fake.executor, files.store, "/app", {
        LLM4TS_NODE_CHECK: "off"
      })
      assert.strictEqual(report._tag, "Off")
      assert.deepStrictEqual(yield* fake.recorded, [])
    })
  )
})

describe("nodePreflight", () => {
  it.effect("aborts the run on a mismatch and tells the events otherwise", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const mismatched = yield* nodeOnPath("v24.12.0")
      yield* files.store.writeAtomic("/app/.nvmrc", "20")
      const error = yield* Effect.flip(
        nodePreflight(mismatched.executor, files.store, events, "/app", {})
      )
      assert.strictEqual(error._tag, "Aborted")
      assert.include(error.message, "v24.12.0")

      const matched = yield* nodeOnPath("v20.16.0")
      yield* nodePreflight(matched.executor, files.store, events, "/app", {})
      const recorded = yield* events.recorded
      const info = recorded.find((event) => event._tag === "Info")
      assert.isDefined(info)
      assert.include(info?._tag === "Info" ? info.message : "", "v20.16.0")
    })
  )
})
