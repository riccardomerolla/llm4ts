# @llm4ts/temporal

Run [llm4ts](https://github.com/riccardomerolla/llm4ts) flows from
[Temporal](https://temporal.io/) workflows: a durable, retried, cancellable
run of `llm4ts run`, one writer per checkout (ADR 0060).

Not published to npm yet; it is built and tested with the other packages.

## What it gives a workflow

- `flowRun`: a workflow that runs one flow on one checkout and returns the
  run that did the work (`runId`, `tracePath`).
- `runFlow` and `steerRun`: the activities behind it, for your own
  workflows.
- Signals `retryStory` and `skipStory`, which reach a live epic through its
  control inbox, and the query `flowRunState`.

## Worker

The worker runs where the checkout is, with `@llm4ts/shell` and a coding
agent installed.

```ts
import { NativeConnection, Worker } from "@temporalio/worker"
import { flowWorkerOptions } from "@llm4ts/temporal"

const worker = await Worker.create({
  ...flowWorkerOptions(),
  connection: await NativeConnection.connect({ address: "localhost:7233" }),
  taskQueue: "llm4ts"
})
await worker.run()
```

`flowWorkerOptions()` supplies the workflow file, the activities and a
heartbeat throttle of five seconds, which keeps a cancellation prompt.

## Start a run

```ts
import { Client } from "@temporalio/client"

const result = await new Client().workflow.execute("flowRun", {
  taskQueue: "llm4ts",
  workflowId: "add-multiply",
  args: [
    {
      repo: "/srv/checkouts/calculator",
      flow: "implement",
      args: ["Add a multiply function"]
    }
  ]
})
```

Inputs are stored in workflow history in plain text. Pass `LLM4TS_*`
settings in `settings`; a secret setting is refused, so keep credentials in
the worker's environment. Settings that llm4ts runs as a command
(`LLM4TS_GATES`, the worktree setup), a coding agent's flags and the `--set`
run flag are refused as well: set those in the worker's environment. A
`LLM4TS_CHILD_ENV_DROP` in the input adds to the worker's list.

## What to expect

- **Retries.** A busy checkout, an interrupted run and a failed launch are
  retried, four attempts by default. A flow that ended failed, a refused
  request and a task that was cut off three times are final.
- **Cancellation.** The workflow closes after the run and the processes it
  started are gone.
- **A worker that dies.** Its run keeps going. The next attempt waits for
  it and returns its id; it does not start a second run.
- **Failure types** (`ApplicationFailure.type`): `InvalidRequest`,
  `FlowFailed`, `TaskCutOff`, `CheckoutBusy`, `RunCutOff`, `LaunchFailed`.
  The failure's first detail is the run id, when a run began.

## Tests

`pnpm test` covers the rules, the activities and the workflow bundle with no
Temporal server. The tests against a dev server and the built CLI are
opt-in:

```bash
pnpm build && LLM4TS_TEMPORAL_LIVE=1 pnpm vitest run packages/temporal/test/live
```

The SDK downloads the dev server on first use; set `LLM4TS_TEMPORAL_SERVER`
to an existing executable to skip that.
