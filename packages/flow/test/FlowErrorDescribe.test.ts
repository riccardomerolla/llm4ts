import { assert, describe, it } from "@effect/vitest"
import { FlowAborted, ProcessError, describeFlowError } from "@llm4ts/flow/FlowError"

describe("describeFlowError", () => {
  // A ProcessError's message is only the command that failed; reporting it
  // alone told a user whose run had just died that "git diff --name-only
  // main...HEAD" happened, and nothing about why.
  it("appends the process output that explains a command failure", () => {
    assert.strictEqual(
      describeFlowError(
        ProcessError.make({
          message: "git diff --name-only main...HEAD",
          detail: "fatal: ambiguous argument 'main...HEAD': unknown revision"
        })
      ),
      "git diff --name-only main...HEAD: fatal: ambiguous argument 'main...HEAD': unknown revision"
    )
  })

  it("leaves errors without detail, and non-errors, readable", () => {
    assert.strictEqual(describeFlowError(FlowAborted.make({ message: "stopped" })), "stopped")
    assert.strictEqual(
      describeFlowError(ProcessError.make({ message: "git status", detail: "   " })),
      "git status"
    )
    assert.strictEqual(describeFlowError("plain string"), "plain string")
  })

  it("does not repeat detail already present in the message", () => {
    assert.strictEqual(
      describeFlowError(ProcessError.make({ message: "git push: rejected", detail: "rejected" })),
      "git push: rejected"
    )
  })
})
