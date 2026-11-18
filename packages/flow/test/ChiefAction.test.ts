import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
  ChiefAction,
  ChiefContext,
  ChiefProposal,
  chiefPrompt,
  failedReply,
  maxReplyChars,
  validateChiefProposal
} from "@llm4ts/flow/ChiefAction"

const context = new ChiefContext({
  messageName: "spaces/s/messages/m1",
  actionPath: "/tmp/action.json",
  request: { text: "please ship the login fix", sender: "users/1" },
  flows: [{ name: "implement", description: "Implement a plan" }],
  runs: [{ runId: "run-7", flow: "implement", state: "running", summary: "editing auth module" }],
  recent: ["earlier message"]
})

const proposal = (fields: Partial<ConstructorParameters<typeof ChiefProposal>[0]>) =>
  new ChiefProposal({ action: "answer", reply: "ok", ...fields })

const violationsOf = (p: ChiefProposal): ReadonlyArray<string> => {
  const result = validateChiefProposal(p, context)
  assert.strictEqual(result._tag, "Invalid")
  return result._tag === "Invalid" ? result.violations : []
}

describe("validateChiefProposal", () => {
  it("rejects a start_run with an unknown flow, naming it", () => {
    const v = violationsOf(proposal({ action: "start_run", flow: "deploy", task: "x" }))
    assert.isTrue(v.some((line) => line.includes("deploy")))
  })

  it("rejects a start_run without a task", () => {
    const v = violationsOf(proposal({ action: "start_run", flow: "implement" }))
    assert.isTrue(v.some((line) => line.includes("task")))
  })

  it("rejects a stop_run with an unknown run id, naming it", () => {
    const v = violationsOf(proposal({ action: "stop_run", runId: "run-99" }))
    assert.isTrue(v.some((line) => line.includes("run-99")))
  })

  it("rejects an empty, whitespace or oversized reply", () => {
    assert.isTrue(violationsOf(proposal({ reply: "" })).some((l) => l.includes("reply")))
    assert.isTrue(violationsOf(proposal({ reply: "  \n " })).some((l) => l.includes("reply")))
    const long = "x".repeat(maxReplyChars + 1)
    assert.isTrue(violationsOf(proposal({ reply: long })).some((l) => l.includes("reply")))
  })

  it("maps each valid proposal to its tagged variant with trimmed fields", () => {
    const valid = (p: ChiefProposal) => {
      const result = validateChiefProposal(p, context)
      assert.strictEqual(result._tag, "Valid")
      return result._tag === "Valid" ? result.action : undefined
    }
    assert.deepStrictEqual(valid(proposal({ reply: "  hi  " })), { _tag: "Answer", reply: "hi" })
    assert.deepStrictEqual(
      valid(
        proposal({ action: "start_run", flow: " implement ", task: " fix it ", reply: " on it " })
      ),
      { _tag: "StartRun", flow: "implement", task: "fix it", reply: "on it" }
    )
    assert.deepStrictEqual(
      valid(proposal({ action: "stop_run", runId: " run-7 ", reply: " stopping " })),
      { _tag: "StopRun", runId: "run-7", reply: "stopping" }
    )
    assert.deepStrictEqual(valid(proposal({ action: "decline", reply: " no " })), {
      _tag: "Decline",
      reply: "no"
    })
  })
})

describe("chiefPrompt", () => {
  it("carries the flows, run summaries, request and the answer-only rule", () => {
    const text = chiefPrompt(context, [])
    assert.include(text, "implement")
    assert.include(text, "editing auth module")
    assert.include(text, "please ship the login fix")
    assert.include(text.toLowerCase(), "only from the text")
  })

  it("lists violations when there are some", () => {
    const text = chiefPrompt(context, ["flow deploy is not allowed"])
    assert.include(text, "flow deploy is not allowed")
  })
})

describe("round trips", () => {
  it("ChiefContext and ChiefAction survive JSON", () => {
    const ctx = Schema.fromJsonString(ChiefContext)
    assert.deepStrictEqual(Schema.decodeSync(ctx)(Schema.encodeSync(ctx)(context)), context)
    const codec = Schema.fromJsonString(ChiefAction)
    const actions: ReadonlyArray<ChiefAction> = [
      { _tag: "Answer", reply: "a" },
      { _tag: "StartRun", flow: "implement", task: "t", reply: "r" },
      { _tag: "StopRun", runId: "run-7", reply: "r" },
      { _tag: "Decline", reply: "d" },
      { _tag: "Failed", reply: failedReply }
    ]
    for (const action of actions) {
      assert.deepStrictEqual(Schema.decodeSync(codec)(Schema.encodeSync(codec)(action)), action)
    }
  })
})
