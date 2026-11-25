import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import {
  childEnvironment,
  childGroups,
  nodeProcessExecutor
} from "@llm4ts/runner/NodeProcessExecutor"

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

  it.effect(
    "captured mode bounds a flood: stdout keeps its head, stderr its tail, each cut marked",
    () =>
      Effect.gen(function* () {
        const result = yield* nodeProcessExecutor.run(
          nodeCommand(
            [
              'const out = []; for (let i = 0; i < 200005; i++) out.push("o" + i)',
              'process.stdout.write(out.join("\\n") + "\\n")',
              'const err = []; for (let i = 0; i < 25000; i++) err.push("e" + i)',
              'process.stderr.write(err.join("\\n") + "\\n")'
            ].join("; ")
          ),
          process.cwd(),
          {}
        )
        assert.strictEqual(result.stdout.length, 200_001)
        assert.strictEqual(result.stdout[0], "o0")
        assert.strictEqual(result.stdout[199_999], "o199999")
        assert.strictEqual(result.stdout.at(-1), "[llm4ts: 5 more line(s) of output not kept]")
        assert.strictEqual(result.stderr.length, 10_001)
        assert.strictEqual(result.stderr[0], "[llm4ts: 15000 earlier line(s) of output not kept]")
        assert.strictEqual(result.stderr.at(-1), "e24999")
      }),
    30_000
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

  it.effect("ends what a child started when the child is ended", () =>
    Effect.gen(function* () {
      // The child starts a process of its own and prints both pids.
      const script =
        'const { spawn } = require("node:child_process");' +
        'const inner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
        'console.log(process.pid + " " + inner.pid); setInterval(() => {}, 1000)'
      const result = yield* Stream.runCollect(
        nodeProcessExecutor
          .runStreaming(nodeCommand(script), process.cwd(), {})
          .pipe(Stream.take(1))
      )
      const [child, inner] = (result[0] ?? "").split(" ").map(Number)
      assert.isTrue(Number.isInteger(child) && Number.isInteger(inner))
      assert.isTrue(yield* eventuallyDead(child ?? 0))
      assert.isTrue(yield* eventuallyDead(inner ?? 0))
      assert.notInclude(childGroups.current(), child)
    })
  )

  it.effect("names a running child's process group while it runs", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<number>> = []
      const unsubscribe = childGroups.subscribe(() => seen.push(childGroups.current()))
      const result = yield* nodeProcessExecutor.run(
        nodeCommand("console.log(process.pid)"),
        process.cwd(),
        {}
      )
      unsubscribe()
      const pid = Number(result.stdout[0])
      assert.isTrue(seen.some((groups) => groups.includes(pid)))
      assert.notInclude(childGroups.current(), pid)
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

describe("childEnvironment", () => {
  it("passes the environment on without the orchestrator's own variables, then the call's", () => {
    assert.deepStrictEqual(
      childEnvironment(
        {
          PATH: "/usr/bin",
          HOME: "/home/me",
          GEMINI_API_KEY: "k",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
          LLM4TS_FLOW: "epic-stories",
          LLM4TS_ROSTER: "/home/me/roster.json",
          _: "/root/.nvm/versions/node/v24.15.0/bin/llm4ts",
          UNSET: undefined
        },
        { MODE: "fast" }
      ),
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        GEMINI_API_KEY: "k",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        MODE: "fast"
      }
    )
  })

  it("withholds the variables LLM4TS_CHILD_ENV_DROP names, by name or wildcard", () => {
    assert.deepStrictEqual(
      childEnvironment(
        {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "a",
          TEMPORAL_API_KEY: "t",
          TEMPORAL_ADDRESS: "cloud:7233",
          AWS_SECRET_ACCESS_KEY: "s",
          MY_AWS_NOTE: "kept",
          GITHUB_TOKEN: "g",
          LLM4TS_CHILD_ENV_DROP: "TEMPORAL_*, AWS_*,GITHUB_TOKEN"
        },
        {}
      ),
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "a", MY_AWS_NOTE: "kept" }
    )
  })

  it("treats every character of a drop-list name but * literally", () => {
    assert.deepStrictEqual(
      childEnvironment({ A_B: "1", AxB: "2", "A.B": "3", LLM4TS_CHILD_ENV_DROP: "A.B" }, {}),
      { A_B: "1", AxB: "2" }
    )
  })

  it("still passes a variable the run sets for the child itself", () => {
    assert.deepStrictEqual(
      childEnvironment(
        { GEMINI_API_KEY: "shell", LLM4TS_CHILD_ENV_DROP: "*_API_KEY" },
        { GEMINI_API_KEY: "bridge" }
      ),
      { GEMINI_API_KEY: "bridge" }
    )
  })

  it.effect("a spawned process does not see LLM4TS_ variables", () =>
    Effect.gen(function* () {
      process.env.LLM4TS_PROBE = "visible"
      try {
        const result = yield* nodeProcessExecutor.run(
          nodeCommand("process.stdout.write(String(process.env.LLM4TS_PROBE))"),
          process.cwd(),
          {}
        )
        assert.strictEqual(result.stdout.join(""), "undefined")
      } finally {
        delete process.env.LLM4TS_PROBE
      }
    })
  )
})
