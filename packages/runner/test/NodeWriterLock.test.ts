import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { nodeWriterLockHost, writerLockPath } from "@llm4ts/runner/NodeWriterLock"

describe("NodeWriterLock", () => {
  it("keys a checkout by its name and real path, under the state home", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm4ts-lock-"))
    try {
      const path = writerLockPath({ XDG_STATE_HOME: "/state" }, directory)
      const name = realpathSync(directory).split("/").pop() ?? ""
      assert.match(path, new RegExp(`^/state/llm4ts/locks/${name}-[0-9a-f]{8}\\.json$`))
      assert.strictEqual(writerLockPath({ XDG_STATE_HOME: "/state" }, `${directory}/.`), path)
      assert.match(
        writerLockPath({ HOME: "/home/op", XDG_STATE_HOME: "" }, directory),
        /^\/home\/op\/\.local\/state\/llm4ts\/locks\//
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.effect("creates a file only when it does not exist yet", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "llm4ts-lock-"))
      const path = join(directory, "nested", "lock.json")
      yield* Effect.gen(function* () {
        assert.isTrue(yield* nodeWriterLockHost.createExclusive(path, "first"))
        assert.isFalse(yield* nodeWriterLockHost.createExclusive(path, "second"))
        assert.strictEqual(readFileSync(path, "utf8"), "first")
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
      )
    })
  )

  it("tells a live process and a live process group from dead ones", () => {
    assert.isTrue(nodeWriterLockHost.isAlive(process.pid))
    assert.isFalse(nodeWriterLockHost.isAlive(0))
    assert.isFalse(nodeWriterLockHost.groupAlive(1))
    assert.isFalse(nodeWriterLockHost.groupAlive(0x7ffffff0))
  })
})
