import { assert, describe, it } from "@effect/vitest"
import {
  classifyEnding,
  dropListWith,
  finalFailures,
  flowActivityOptions,
  isRetryable,
  runIdFor,
  steerIdFor,
  workerDefaults
} from "@llm4ts/temporal/Policy"

describe("flowActivityOptions", () => {
  it("bounds the retries and never retries a failure a retry cannot change", () => {
    const options = flowActivityOptions()
    assert.strictEqual(options.retry.maximumAttempts, 4)
    assert.deepStrictEqual(options.retry.nonRetryableErrorTypes, [
      "InvalidRequest",
      "FlowFailed",
      "TaskCutOff"
    ])
    assert.strictEqual(flowActivityOptions({ maximumAttempts: 2 }).retry.maximumAttempts, 2)
  })

  it("closes a cancelled workflow only after the activity has stopped", () => {
    assert.strictEqual(flowActivityOptions().cancellationType, "WAIT_CANCELLATION_COMPLETED")
  })

  it("keeps a cancellation within seconds of the request", () => {
    assert.strictEqual(flowActivityOptions().heartbeatTimeout, "20 seconds")
    assert.strictEqual(workerDefaults.maxHeartbeatThrottleInterval, 5_000)
  })
})

describe("classifyEnding", () => {
  const failed = (ending: Parameters<typeof classifyEnding>[0]) => {
    const verdict = classifyEnding(ending)
    return verdict._tag === "Failed" ? verdict.type : verdict._tag
  }

  it("counts a run as completed only when its trace says so and the process agreed", () => {
    assert.strictEqual(
      failed({ exitCode: 0, ended: { outcome: "completed" }, busy: false }),
      "Completed"
    )
    assert.strictEqual(failed({ ended: { outcome: "completed" }, busy: false }), "Completed")
    assert.strictEqual(
      failed({ exitCode: 1, ended: { outcome: "completed" }, busy: false }),
      "FlowFailed"
    )
    assert.strictEqual(failed({ exitCode: 0, busy: false }), "RunCutOff")
  })

  it("makes a red epic final", () => {
    const ending = {
      exitCode: 1,
      ended: { outcome: "failed", error: "EpicUnfinished" },
      busy: false
    }
    assert.strictEqual(failed(ending), "FlowFailed")
    assert.isFalse(isRetryable("FlowFailed"))
  })

  it("makes a task that is not started again final, so retries end", () => {
    const ending = { exitCode: 1, ended: { outcome: "failed", error: "TaskCutOff" }, busy: false }
    assert.strictEqual(failed(ending), "TaskCutOff")
    assert.include(finalFailures, "TaskCutOff")
  })

  it("retries a busy checkout, whether the run said so or never began", () => {
    assert.strictEqual(
      failed({ exitCode: 1, ended: { outcome: "failed", error: "CheckoutBusy" }, busy: false }),
      "CheckoutBusy"
    )
    assert.strictEqual(failed({ exitCode: 1, busy: true }), "CheckoutBusy")
    assert.isTrue(isRetryable("CheckoutBusy"))
  })

  it("retries a run that was interrupted or whose process died", () => {
    assert.strictEqual(
      failed({ exitCode: 130, ended: { outcome: "interrupted" }, busy: false }),
      "RunCutOff"
    )
    assert.strictEqual(failed({ busy: false }), "RunCutOff")
    assert.strictEqual(failed({ exitCode: 137, busy: false }), "RunCutOff")
    assert.isTrue(isRetryable("RunCutOff"))
  })

  it("tells a launch that failed from a run that was cut off", () => {
    assert.strictEqual(failed({ exitCode: 2, busy: false }), "LaunchFailed")
  })
})

describe("derived ids", () => {
  it("names an attempt's run from the workflow, the activity and the attempt", () => {
    assert.strictEqual(runIdFor("epic/42 a", "1", 2), "tw-epic_42_a-1-2")
    assert.strictEqual(runIdFor("w", "1", 2), runIdFor("w", "1", 2))
    assert.notStrictEqual(runIdFor("w", "1", 1), runIdFor("w", "1", 2))
  })

  it("numbers a workflow's commands", () => {
    assert.strictEqual(steerIdFor("w 1", 3), "tw-w_1-steer-3")
  })
})

describe("dropListWith", () => {
  it("adds the worker's variables to the drop list once", () => {
    assert.strictEqual(dropListWith(undefined), "TEMPORAL_*")
    assert.strictEqual(dropListWith([]), "TEMPORAL_*")
    assert.strictEqual(dropListWith(["AWS_*"]), "AWS_*,TEMPORAL_*")
    assert.strictEqual(dropListWith(["AWS_*", " TEMPORAL_*"]), "AWS_*,TEMPORAL_*")
  })
})
