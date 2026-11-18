/**
 * The Chief of Staff's decision for one chat request: a model proposes, this
 * module validates the proposal against what the context allows and turns it
 * into a tagged action. Pure: the chat loop acts on the action.
 */
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"

export const maxReplyChars = 4000

export class ChiefContext extends Schema.Class<ChiefContext>("ChiefContext")({
  messageName: Schema.String,
  /** Where the chief flow writes its ChiefAction. */
  actionPath: Schema.String,
  request: Schema.Struct({ text: Schema.String, sender: Schema.String }),
  flows: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  // `state` stays a plain string: the chat layer owns the run-state vocabulary.
  runs: Schema.Array(
    Schema.Struct({
      runId: Schema.String,
      flow: Schema.String,
      state: Schema.String,
      summary: Schema.String
    })
  ),
  diagnosis: Schema.optional(Schema.String),
  recent: Schema.Array(Schema.String)
}) {}

export class ChiefProposal extends Schema.Class<ChiefProposal>("ChiefProposal")({
  action: Schema.Literals(["answer", "start_run", "stop_run", "decline"]),
  reply: Schema.String,
  flow: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String)
}) {}

export const chiefProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["answer", "start_run", "stop_run", "decline"] },
    reply: { type: "string" },
    flow: { type: "string" },
    task: { type: "string" },
    runId: { type: "string" }
  },
  required: ["action", "reply"]
}

export const ChiefAction = Schema.Union([
  Schema.TaggedStruct("Answer", { reply: Schema.String }),
  Schema.TaggedStruct("StartRun", {
    flow: Schema.String,
    task: Schema.String,
    reply: Schema.String
  }),
  Schema.TaggedStruct("StopRun", { runId: Schema.String, reply: Schema.String }),
  Schema.TaggedStruct("Decline", { reply: Schema.String }),
  // Carries the fixed reply after two invalid proposals, so the loop can log the request as failed.
  Schema.TaggedStruct("Failed", { reply: Schema.String })
])
export type ChiefAction = typeof ChiefAction.Type

export const failedReply = "I could not work that out. Try rephrasing the request."

export type ChiefValidation =
  | { readonly _tag: "Valid"; readonly action: ChiefAction }
  | { readonly _tag: "Invalid"; readonly violations: ReadonlyArray<string> }

const present = (value: string | undefined): string => value?.trim() ?? ""

export const validateChiefProposal = (
  proposal: ChiefProposal,
  context: ChiefContext
): ChiefValidation => {
  const violations: Array<string> = []
  const reply = present(proposal.reply)
  if (reply === "") violations.push("The reply is empty; write a short reply for the chat.")
  else if (reply.length > maxReplyChars) {
    violations.push(`The reply is ${reply.length} characters; keep it under ${maxReplyChars}.`)
  }
  const flow = present(proposal.flow)
  const task = present(proposal.task)
  const runId = present(proposal.runId)
  if (proposal.action === "start_run") {
    if (!context.flows.some((entry) => entry.name === flow)) {
      violations.push(
        `The flow "${flow}" is not allowed; choose one of: ${context.flows.map((f) => f.name).join(", ")}.`
      )
    }
    if (task === "") violations.push("A start_run needs a task describing the work.")
  }
  if (proposal.action === "stop_run" && !context.runs.some((run) => run.runId === runId)) {
    violations.push(`The run "${runId}" is not one of the runs listed in the context.`)
  }
  if (violations.length > 0) return { _tag: "Invalid", violations }
  switch (proposal.action) {
    case "answer":
      return { _tag: "Valid", action: { _tag: "Answer", reply } }
    case "start_run":
      return { _tag: "Valid", action: { _tag: "StartRun", flow, task, reply } }
    case "stop_run":
      return { _tag: "Valid", action: { _tag: "StopRun", runId, reply } }
    case "decline":
      return { _tag: "Valid", action: { _tag: "Decline", reply } }
  }
}

export const chiefPrompt = (context: ChiefContext, violations: ReadonlyArray<string>): string => {
  const flows = context.flows.map((f) => `- ${f.name}: ${f.description}`).join("\n")
  const runs =
    context.runs.length === 0
      ? "(none)"
      : context.runs.map((r) => `- ${r.runId} [${r.flow}, ${r.state}]: ${r.summary}`).join("\n")
  const recent =
    context.recent.length === 0 ? "(none)" : context.recent.map((r) => `- ${r}`).join("\n")
  return [
    "You are the Chief of Staff answering one chat request.",
    "Decide one action: answer, start_run, stop_run or decline.",
    "Answer only from the text below; if it does not hold the answer, say so instead of guessing.",
    `Keep the reply under ${maxReplyChars} characters.`,
    "",
    "Flows you may start (start_run needs one of these names and a task):",
    flows,
    "",
    "Runs (stop_run needs one of these run ids):",
    runs,
    ...(context.diagnosis === undefined ? [] : ["", "Diagnosis:", context.diagnosis]),
    "",
    "Recent messages:",
    recent,
    "",
    `Request from ${context.request.sender}:`,
    context.request.text,
    ...(violations.length === 0
      ? []
      : ["", "Your previous proposal was invalid. Fix these:", ...violations.map((v) => `- ${v}`)])
  ].join("\n")
}
