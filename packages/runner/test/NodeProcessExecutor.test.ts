import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const nodeCommand = (script: string): ReadonlyArray<string> => [process.execPath, "-e", script]

const realDelay = (milliseconds: number): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const eventuallyDead = (pid: number, attempts = 50): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    if (!processIsAlive(pid)) {
      return Effect.succeed(true)
    }
    if (attempts <= 1) {
      return Effect.succeed(false)
    }
    return realDelay(10).pipe(Effect.andThen(eventuallyDead(pid, attempts - 1)))
  })

describe("NodeProcessExecutor", () => {
  it.effect("captures stdout, stderr, and a non-zero exit as result data", () =>
    Effect.gen(function* () {
      const result = yield* nodeProcessExecutor.run(
        nodeCommand('console.log("out-line"); console.error("err-line"); process.exitCode = 7'),
        process.cwd(),
        {}
      )

      assert.deepStrictEqual(result.stdout, ["out-line"])
      assert.deepStrictEqual(result.stderr, ["err-line"])
      assert.strictEqual(result.exitCode, 7)
    })
  )

  it.effect("fails when the executable cannot be started", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nodeProcessExecutor.run(["definitely-not-a-real-binary-llm4ts"], process.cwd(), {})
      )

      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /definitely-not-a-real-binary-llm4ts/)
    })
  )

  it.effect("feeds stdin to captured and streaming processes", () =>
    Effect.gen(function* () {
      const echoScript =
        'let data=""; process.stdin.setEncoding("utf8"); ' +
        'process.stdin.on("data", chunk => data += chunk); ' +
        'process.stdin.on("end", () => process.stdout.write(data))'
      const argv = nodeCommand(echoScript)

      const captured = yield* nodeProcessExecutor.runWithStdin(argv, process.cwd(), {}, "one\ntwo")
      const streamed = yield* Stream.runCollect(
        nodeProcessExecutor.runStreamingWithStdin(argv, process.cwd(), {}, "alpha\nbeta")
      )

      assert.deepStrictEqual(captured.stdout, ["one", "two"])
      assert.deepStrictEqual(streamed, ["alpha", "beta"])
    })
  )

  it.effect("streams stdout lines and reports non-zero stderr failures", () =>
    Effect.gen(function* () {
      const lines = yield* Stream.runCollect(
        nodeProcessExecutor.runStreaming(
          nodeCommand('console.log("one"); console.log("two")'),
          process.cwd(),
          {}
        )
      )
      const error = yield* Effect.flip(
        Stream.runCollect(
          nodeProcessExecutor.runStreaming(
            nodeCommand('console.log("out"); console.error("boom"); process.exitCode = 7'),
            process.cwd(),
            {}
          )
        )
      )

      assert.deepStrictEqual(lines, ["one", "two"])
      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /boom/)
      assert.match(error.message, /7/)
    })
  )

  it.effect("kills a streaming child when downstream stops early", () =>
    Effect.gen(function* () {
      const result = yield* Stream.runCollect(
        nodeProcessExecutor
          .runStreaming(
            nodeCommand("console.log(process.pid); setInterval(() => {}, 1000)"),
            process.cwd(),
            {}
          )
          .pipe(Stream.take(1))
      )
      const pid = Number(result[0])
      const dead = yield* eventuallyDead(pid)

      assert.isTrue(Number.isInteger(pid))
      assert.isTrue(dead)
    })
  )

  it.effect("supports a scoped bidirectional line session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [input, output] = yield* nodeProcessExecutor.runBidirectional(
          nodeCommand(
            'const rl=require("node:readline").createInterface({input:process.stdin}); ' +
              'rl.on("line", line => console.log(line))'
          ),
          process.cwd(),
          {}
        )
        const fiber = yield* Effect.forkChild(Stream.runCollect(output.pipe(Stream.take(2))))

        yield* Queue.offer(input, "alpha")
        yield* Queue.offer(input, "beta")
        const lines = yield* Fiber.join(fiber)

        assert.deepStrictEqual(lines, ["alpha", "beta"])
      })
    )
  )
})
