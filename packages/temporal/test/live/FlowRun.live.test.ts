import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { WorkflowFailedError } from "@temporalio/client"
import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/common"
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing"
import { Worker } from "@temporalio/worker"
import { makeFlowActivities } from "@llm4ts/temporal/Activities"
import { flowWorkerOptions } from "@llm4ts/temporal/Worker"
import {
  flowRunState,
  skipStory,
  type FlowRunState,
  type flowRun
} from "@llm4ts/temporal/Workflows"
import { makeNodeFlowHost } from "@llm4ts/temporal/NodeFlowHost"

/**
 * The integration against a real Temporal dev server and the built `llm4ts`
 * CLI, with a stub coding agent. Not part of the default run: it needs
 * `pnpm build` and Temporal's dev server, which the SDK downloads on first
 * use (set LLM4TS_TEMPORAL_SERVER to an existing executable to avoid that).
 *
 *     pnpm build && LLM4TS_TEMPORAL_LIVE=1 pnpm vitest run packages/temporal/test/live
 */
const live = process.env.LLM4TS_TEMPORAL_LIVE === "1" && process.platform !== "win32"
const root = fileURLToPath(new URL("../../../..", import.meta.url))
const cli = join(root, "packages/shell/dist/cli-main.js")
const workflowsPath = fileURLToPath(new URL("../../src/Workflows.ts", import.meta.url))

// A stand-in `claude`: a two-task plan, clean reviews, one edit per coding
// turn. A coding turn sleeps for the seconds in <sandbox>/sleep and fails
// while <sandbox>/fail exists. Every coding turn records whether it saw the
// worker's Temporal credential.
const stub = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const sandbox = path.dirname(__dirname)
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  let text
  if (prompt.includes("planning assistant")) {
    text = JSON.stringify({ epicId: "calculator", tasks: [
      { title: "Add multiply", description: "Add a multiply function", completed: false },
      { title: "Test multiply", description: "Cover multiply with a test", completed: false }
    ] })
  } else if (prompt.includes("Report problems as JSON")) {
    text = JSON.stringify({ issues: [], summary: "clean" })
  } else {
    fs.appendFileSync(path.join(sandbox, "agent.log"),
      "START pid=" + process.pid + " TEMPORAL_API_KEY=" + (process.env.TEMPORAL_API_KEY === undefined ? "absent" : "present") + "\\n")
    if (fs.existsSync(path.join(sandbox, "fail"))) { process.stderr.write("stub: told to fail"); process.exit(3) }
    let seconds = 0
    try { seconds = Number(fs.readFileSync(path.join(sandbox, "sleep"), "utf8")) } catch {}
    if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
    fs.appendFileSync("calculator.txt", "step\\n")
    text = "Implemented the task."
  }
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
  emit({ type: "system", subtype: "init", model: "stub-claude-1" })
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } })
  emit({ type: "result", usage: { input_tokens: 100, output_tokens: 40 } })
})
`

const makeSandbox = (): { sandbox: string; repo: string; environment: Record<string, string> } => {
  const sandbox = mkdtempSync(join(tmpdir(), "llm4ts-temporal-live-"))
  const repo = join(sandbox, "repo")
  for (const directory of ["home", "bin", "repo"]) mkdirSync(join(sandbox, directory))
  writeFileSync(join(sandbox, "bin", "claude"), stub)
  chmodSync(join(sandbox, "bin", "claude"), 0o755)
  const git = (...args: Array<string>) => execFileSync("git", ["-C", repo, ...args])
  git("init", "-q", "-b", "main")
  git("config", "user.email", "live@llm4ts.test")
  git("config", "user.name", "llm4ts live")
  writeFileSync(join(repo, ".gitignore"), ".llm4ts/\n")
  writeFileSync(join(repo, "README.md"), "# sandbox\n")
  git("add", "-A")
  git("commit", "-qm", "init")
  return {
    sandbox,
    repo,
    environment: {
      PATH: `${join(sandbox, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(sandbox, "home"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      NO_COLOR: "1",
      LLM4TS_CODER: "claude",
      LLM4TS_ROSTER: "none",
      // What a worker on Temporal Cloud holds; it must stop at the flow.
      TEMPORAL_API_KEY: "live-test-placeholder"
    }
  }
}

const until = async (test: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "")

describe.skipIf(!live)("flowRun against a Temporal dev server", () => {
  let environment: TestWorkflowEnvironment
  const sandboxes: Array<string> = []

  beforeAll(async () => {
    const existing = process.env.LLM4TS_TEMPORAL_SERVER
    environment = await TestWorkflowEnvironment.createLocal(
      existing === undefined
        ? {}
        : { server: { executable: { type: "existing-path", path: existing } } }
    )
  }, 120_000)

  afterAll(async () => {
    await environment.teardown()
    for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true })
  })

  const withWorker = async <A>(
    taskQueue: string,
    hostEnvironment: Record<string, string>,
    use: () => Promise<A>
  ): Promise<A> => {
    const worker = await Worker.create({
      ...flowWorkerOptions({ host: makeNodeFlowHost({ cli, environment: hostEnvironment }) }),
      workflowsPath,
      connection: environment.nativeConnection,
      taskQueue
    })
    return worker.runUntil(use)
  }

  const request = (repo: string) => ({
    repo,
    flow: "implement",
    args: ["Add a multiply function"]
  })

  it("runs a flow to the end and returns the run that did the work", async () => {
    const box = makeSandbox()
    sandboxes.push(box.sandbox)
    const result = await withWorker("q-complete", box.environment, () =>
      environment.client.workflow.execute<typeof flowRun>("flowRun", {
        taskQueue: "q-complete",
        workflowId: "live-complete",
        args: [request(box.repo)]
      })
    )
    assert.deepStrictEqual(result, {
      runId: "tw-live-complete-1-1",
      tracePath: join(box.repo, ".llm4ts", "trace-tw-live-complete-1-1.jsonl"),
      outcome: "completed",
      attempt: 1,
      adopted: false
    })
    assert.match(
      read(result.tracePath),
      /"runId":"tw-live-complete-1-1","kind":"RunEnded","fields":\{"outcome":"completed"\}/
    )
    const log = execFileSync("git", ["-C", box.repo, "log", "--oneline", "calculator"]).toString()
    assert.match(log, /calculator: Add multiply/)
    assert.match(log, /calculator: Test multiply/)
    // The worker's credential stopped at the flow (ADR 0059).
    const agent = read(join(box.sandbox, "agent.log"))
    assert.include(agent, "TEMPORAL_API_KEY=absent")
    assert.notInclude(agent, "TEMPORAL_API_KEY=present")
  }, 120_000)

  it("a cancelled workflow closes only once its run is gone, and the checkout is free at once", async () => {
    const box = makeSandbox()
    sandboxes.push(box.sandbox)
    writeFileSync(join(box.sandbox, "sleep"), "120")
    await withWorker("q-cancel", box.environment, async () => {
      const handle = await environment.client.workflow.start<typeof flowRun>("flowRun", {
        taskQueue: "q-cancel",
        workflowId: "live-cancel",
        args: [request(box.repo)]
      })
      await until(() => read(join(box.sandbox, "agent.log")).includes("START"))
      const agentPid = Number(/START pid=(\d+)/.exec(read(join(box.sandbox, "agent.log")))?.[1])

      // A command for a live epic reaches its control inbox.
      await handle.signal(skipStory, { epic: "demo-epic", story: "slow", reason: "burning tokens" })
      let steered: FlowRunState["steered"] = []
      for (let tries = 0; tries < 100 && steered.length === 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        steered = (await handle.query(flowRunState)).steered
      }
      assert.deepStrictEqual(steered, [{ id: "tw-live-cancel-steer-1", written: true }])

      const asked = Date.now()
      await handle.cancel()
      const error = await handle.result().then(
        () => undefined,
        (failure: unknown) => failure
      )
      const closedAfter = Date.now() - asked
      assert.instanceOf(error, WorkflowFailedError)
      assert.instanceOf(error.cause, CancelledFailure)
      // When the workflow has closed, nothing of its run is left.
      let agentAlive = true
      try {
        process.kill(agentPid, 0)
      } catch {
        agentAlive = false
      }
      assert.isFalse(agentAlive, "the coding agent outlived the cancelled workflow")
      assert.isBelow(closedAfter, 30_000)
      console.log(`cancellation: workflow closed ${closedAfter} ms after the request`)

      // The next workflow on the same checkout is not refused.
      rmSync(join(box.sandbox, "sleep"))
      const next = await environment.client.workflow.execute<typeof flowRun>("flowRun", {
        taskQueue: "q-cancel",
        workflowId: "live-after-cancel",
        args: [request(box.repo)]
      })
      assert.strictEqual(next.runId, "tw-live-after-cancel-1-1")
    })
  }, 180_000)

  it("a flow that fails is not retried", async () => {
    const box = makeSandbox()
    sandboxes.push(box.sandbox)
    writeFileSync(join(box.sandbox, "fail"), "")
    const error = await withWorker("q-fail", box.environment, () =>
      environment.client.workflow
        .execute<typeof flowRun>("flowRun", {
          taskQueue: "q-fail",
          workflowId: "live-fail",
          args: [request(box.repo)]
        })
        .then(
          () => undefined,
          (failure: unknown) => failure
        )
    )
    assert.instanceOf(error, WorkflowFailedError)
    assert.instanceOf(error.cause, ActivityFailure)
    const cause = error.cause.cause
    assert.instanceOf(cause, ApplicationFailure)
    assert.strictEqual(cause.type, "FlowFailed")
    assert.deepStrictEqual(cause.details, ["tw-live-fail-1-1"])
    // One attempt only: the stub was asked to code once.
    assert.strictEqual(
      read(join(box.sandbox, "agent.log"))
        .split("\n")
        .filter((line) => line.startsWith("START")).length,
      1
    )
  }, 120_000)

  it("a retry after its worker died waits for the run that survived, and starts no second writer", async () => {
    const box = makeSandbox()
    sandboxes.push(box.sandbox)
    writeFileSync(join(box.sandbox, "sleep"), "4")
    const host = makeNodeFlowHost({ cli, environment: box.environment })
    // Attempt 1's run, left behind by a worker that was killed: started the
    // way the activity starts it, with nobody waiting on it.
    const orphanId = "tw-live-orphan-1-1"
    const orphan = spawn(
      process.execPath,
      [cli, "run", "--roster", "none", "implement", "--", "Add a multiply function"],
      {
        cwd: box.repo,
        env: {
          ...box.environment,
          LLM4TS_RUN_ID: orphanId,
          LLM4TS_TRACE_PATH: join(box.repo, ".llm4ts", `trace-${orphanId}.jsonl`)
        },
        stdio: "ignore",
        detached: true
      }
    )
    orphan.unref()
    await until(() => read(join(box.sandbox, "agent.log")).includes("START"))

    const attempt2 = new MockActivityEnvironment({
      attempt: 2,
      activityId: "1",
      workflowExecution: { workflowId: "live-orphan", runId: "r" }
    })
    const result = await attempt2.run(makeFlowActivities(host).runFlow, request(box.repo))
    assert.deepStrictEqual(result, {
      runId: orphanId,
      tracePath: join(box.repo, ".llm4ts", `trace-${orphanId}.jsonl`),
      outcome: "completed",
      attempt: 2,
      adopted: true
    })
    // One writer: each task was coded and committed once, by the first run.
    const log = execFileSync("git", ["-C", box.repo, "log", "--oneline", "calculator"]).toString()
    assert.strictEqual(log.split("\n").filter((line) => line.includes("calculator:")).length, 2)
    assert.isFalse(existsSync(join(box.repo, ".llm4ts", "trace-tw-live-orphan-1-2.jsonl")))
  }, 120_000)
})
