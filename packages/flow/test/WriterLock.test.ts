import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { CheckoutBusy } from "@llm4ts/flow/FlowError"
import { makeMemoryWriterLockHost, makeWriterLock } from "@llm4ts/flow/WriterLock"

const path = "/state/llm4ts/locks/app-0a1b2c3d.json"
const request = (runId: string) => ({
  path,
  workDir: "/work/app",
  runId,
  flow: "implement",
  startedAt: 1
})

/** Two processes over one disk: pid 100 and pid 200. */
const twoProcesses = Effect.gen(function* () {
  const first = yield* makeMemoryWriterLockHost(100)
  const second = yield* makeMemoryWriterLockHost(200, first)
  return { disk: first, first: makeWriterLock(first.host), second: makeWriterLock(second.host) }
})

describe("WriterLock", () => {
  it.effect("refuses a second writing run and names the holder", () =>
    Effect.gen(function* () {
      const { first, second } = yield* twoProcesses
      const scope = yield* Scope.make()
      yield* first.hold(request("run-1")).pipe(Scope.provide(scope))
      const refused = yield* Effect.scoped(second.hold(request("run-2"))).pipe(Effect.flip)
      assert.instanceOf(refused, CheckoutBusy)
      if (refused instanceof CheckoutBusy) {
        assert.strictEqual(refused.runId, "run-1")
        assert.strictEqual(refused.pid, 100)
        assert.strictEqual(refused.alive, "run")
        assert.match(refused.message, /\/work\/app is being written by run run-1 \(implement\)/)
      }
      assert.strictEqual((yield* second.holder(path))?.holder.runId, "run-1")
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect("is released when the run's scope closes", () =>
    Effect.gen(function* () {
      const { disk, first, second } = yield* twoProcesses
      yield* Effect.scoped(first.hold(request("run-1")))
      assert.deepStrictEqual(yield* disk.files, {})
      yield* Effect.scoped(second.hold(request("run-2")))
      assert.isUndefined(yield* second.holder(path))
    })
  )

  it.effect("is taken over once its holder is dead", () =>
    Effect.gen(function* () {
      const { disk, first, second } = yield* twoProcesses
      const abandoned = yield* Scope.make()
      yield* first.hold(request("run-1")).pipe(Scope.provide(abandoned))
      disk.setAlive(100, false)
      assert.isUndefined(yield* second.holder(path))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* second.hold(request("run-2"))
          assert.strictEqual((yield* second.holder(path))?.holder.runId, "run-2")
        })
      )
    })
  )

  it.effect("still holds for a dead run while a process group it started is alive", () =>
    Effect.gen(function* () {
      const { disk, first, second } = yield* twoProcesses
      const abandoned = yield* Scope.make()
      const held = yield* first.hold(request("run-1")).pipe(Scope.provide(abandoned))
      yield* held.setGroups([4321, 4400])
      disk.setGroupAlive(4321, true)
      disk.setAlive(100, false)
      const refused = yield* Effect.scoped(second.hold(request("run-2"))).pipe(Effect.flip)
      assert.instanceOf(refused, CheckoutBusy)
      if (refused instanceof CheckoutBusy) {
        assert.strictEqual(refused.alive, "children")
        assert.deepStrictEqual(refused.groups, [4321])
        assert.match(refused.message, /run run-1 \(implement\) is gone, but processes it started/)
      }
      disk.setGroupAlive(4321, false)
      yield* Effect.scoped(second.hold(request("run-2")))
    })
  )

  it.effect("lets a run nested in the holding process share the hold", () =>
    Effect.gen(function* () {
      const { first, second } = yield* twoProcesses
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* first.hold(request("run-1"))
          yield* Effect.scoped(first.hold(request("run-nested")))
          // The nested run's end did not release the outer run's hold.
          const refused = yield* Effect.scoped(second.hold(request("run-2"))).pipe(Effect.flip)
          assert.instanceOf(refused, CheckoutBusy)
        })
      )
    })
  )

  it.effect("removes a guard file left by a dead process", () =>
    Effect.gen(function* () {
      const { disk, second } = yield* twoProcesses
      yield* disk.host.files.writeAtomic(`${path}.guard`, "999")
      yield* Effect.scoped(second.hold(request("run-2")))
      assert.deepStrictEqual(yield* disk.files, {})
    })
  )
})
