import { assert, describe, it } from "@effect/vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeGitTool } from "@llm4ts/flow/GitTool"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const temporaryRepository = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-git-"))),
  (directory) =>
    Effect.promise(() =>
      rm(directory, {
        recursive: true,
        force: true
      })
    )
)

describe("GitTool", () => {
  it.effect("covers local init, commit, branch, diff, checkpoint, and rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n", "utf8"))
        assert.strictEqual((yield* git.commitAll("first"))._tag, "Committed")
        const checkpoint = yield* git.checkpoint
        assert.strictEqual(yield* git.currentBranch, "main")

        assert.strictEqual((yield* git.createBranch("feature"))._tag, "Created")
        assert.strictEqual((yield* git.createBranch("feature"))._tag, "AlreadyExists")
        yield* git.checkout("feature")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "two\n", "utf8"))
        assert.match(yield* git.diff, /two/)
        yield* git.commitAll("second")
        yield* git.rollback(checkpoint)

        assert.strictEqual(
          yield* Effect.promise(() => readFile(join(root, "value.txt"), "utf8")),
          "one\n"
        )
        assert.strictEqual(yield* git.status, "")
      })
    )
  )

  it.effect("keeps read, write, and push grants distinct and audits denials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        const readOnly = new Grants({
          ...allGrants,
          git: "Read"
        })
        const writeOnly = new Grants({
          ...allGrants,
          git: "Write"
        })

        yield* restricted(readOnly)(git.status)
        const commitDenied = yield* Effect.flip(restricted(readOnly)(git.commitAll("denied")))
        const pushDenied = yield* Effect.flip(restricted(writeOnly)(git.push("origin", "main")))
        const recorded = yield* events.recorded

        assert.strictEqual(commitDenied._tag, "CapabilityDenied")
        assert.strictEqual(pushDenied._tag, "CapabilityDenied")
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "CapabilityDenied" && event.capability === "GitWrite"
          )
        )
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "CapabilityDenied" && event.capability === "GitPush"
          )
        )
      })
    )
  )
})
