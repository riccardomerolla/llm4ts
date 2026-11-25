import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { installedCli, makeNodeFlowHost } from "@llm4ts/temporal/NodeFlowHost"

// A stand-in for the llm4ts bin: records what it was given, starts a child of
// its own, and stays alive until it is signalled.
const script = `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const child = spawn(process.execPath, ["-e", "process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.env.OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), child: child.pid, marker: process.env.MARKER }))
// Like \`llm4ts run\`: the interrupt is for the process it started, in its group.
let interrupted = false
process.on("SIGINT", () => { interrupted = true })
child.once("exit", () => process.exit(interrupted ? 130 : 1))
setInterval(() => {}, 1000)
`

const withSandbox = <A, E>(use: (directory: string, cli: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(join(tmpdir(), "llm4ts-temporal-"))
      const cli = join(directory, "cli.cjs")
      writeFileSync(cli, script)
      return { directory, cli }
    }),
    ({ directory, cli }) => use(directory, cli),
    ({ directory }) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )

const waitFor = (test: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200 && !test(); tries++) yield* Effect.sleep(25)
    assert.isTrue(test(), "the condition did not hold within 5 s")
  })

const start = (directory: string, cli: string) => {
  const out = join(directory, "out.json")
  const host = makeNodeFlowHost({ cli, environment: { PATH: process.env.PATH } })
  return Effect.gen(function* () {
    const child = yield* host.start({
      args: ["run", "implement"],
      cwd: directory,
      environment: { PATH: process.env.PATH, OUT: out, MARKER: "given" }
    })
    yield* waitFor(() => existsSync(out))
    const seen: unknown = JSON.parse(readFileSync(out, "utf8"))
    return { host, child, seen }
  })
}

const grandchildOf = (seen: unknown): number =>
  typeof seen === "object" && seen !== null && "child" in seen && typeof seen.child === "number"
    ? seen.child
    : 0

describe.skipIf(process.platform === "win32")("makeNodeFlowHost", () => {
  it.live("starts the bin as asked, and an interrupt reaches the process it started", () =>
    withSandbox((directory, cli) =>
      Effect.gen(function* () {
        const { host, child, seen } = yield* start(directory, cli)
        assert.deepInclude(seen, { args: ["run", "implement"], marker: "given" })
        assert.isTrue(host.isAlive(child.pid))
        yield* host.interrupt(child.pid)
        assert.deepStrictEqual(yield* child.exited, { code: 130 })
        yield* host.killGroup(child.pid)
      })
    )
  )

  it.live("ends the process and what it started with one kill of its group", () =>
    withSandbox((directory, cli) =>
      Effect.gen(function* () {
        const { host, child, seen } = yield* start(directory, cli)
        const grandchild = grandchildOf(seen)
        assert.isTrue(host.isAlive(grandchild))
        yield* host.killGroup(child.pid)
        assert.deepStrictEqual(yield* child.exited, { signal: "SIGKILL" })
        yield* waitFor(() => !host.isAlive(grandchild))
      })
    )
  )

  it.live("fails with a typed error when the bin cannot start", () =>
    Effect.gen(function* () {
      const host = makeNodeFlowHost({ cli: "cli.cjs", environment: {} })
      const error = yield* Effect.flip(
        host.start({ args: [], cwd: "/no/such/directory", environment: {} })
      )
      assert.strictEqual(error._tag, "LaunchError")
    })
  )

  it("finds the installed shell's bin", () => {
    assert.match(installedCli(), /shell\/dist\/cli-main\.js$/)
  })
})
