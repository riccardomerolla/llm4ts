import { assert, describe, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-phase7-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
)

describe("symlink-aware bounded workspace", () => {
  it.effect("rejects traversal, external symlinks, oversize content, and result overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory
        const outside = yield* temporaryDirectory
        yield* Effect.promise(() => writeFile(join(outside, "secret"), "no"))
        yield* Effect.promise(() => symlink(outside, join(root, "external"), "dir"))
        yield* Effect.promise(() => mkdir(join(root, "many")))
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(root, "many", "a"), "x"),
            writeFile(join(root, "many", "b"), "x"),
            writeFile(join(root, "many", "big"), "1234")
          ])
        )
        const workspace = yield* makeNodeWorkspace(root, {
          maxReadBytes: 3,
          maxWriteBytes: 3,
          maxResults: 1,
          maxDepth: 4
        })

        const traversal = yield* Effect.flip(workspace.resolve("../outside"))
        const symlinkEscape = yield* Effect.flip(workspace.read("external/secret"))
        const oversize = yield* Effect.flip(workspace.write("large", "1234"))
        const oversizeRead = yield* Effect.flip(workspace.read("many/big"))
        const overflow = yield* Effect.flip(workspace.discover("**/*"))

        assert.strictEqual(traversal._tag, "WorkspacePath")
        assert.strictEqual(symlinkEscape._tag, "WorkspacePath")
        assert.strictEqual(oversize._tag, "WorkspaceLimit")
        // The limit error names the offending file so an estate-sized read
        // failure is actionable without re-running under a debugger.
        assert.strictEqual(oversize._tag === "WorkspaceLimit" ? oversize.path : "", "large")
        assert.strictEqual(oversizeRead._tag, "WorkspaceLimit")
        assert.include(oversizeRead.message, "many/big")
        assert.strictEqual(overflow._tag, "WorkspaceLimit")
      })
    )
  )
})
