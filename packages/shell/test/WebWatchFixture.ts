import { readFileSync } from "node:fs"
import * as Schema from "effect/Schema"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { emptyTree } from "@llm4ts/runner/AgentTree"
import type { WebFrame } from "../src/WebFrame.ts"
import { foldSteps, frameOf, stepsOfTrace } from "../src/WebWatchView.ts"

/** The agent-tree fixture run (50 steps, iban fails at seq 32), as `watch --web` folds it. */

export const runnerFixture = (name: string): string =>
  readFileSync(new URL(`../../runner/test/fixtures/${name}`, import.meta.url), "utf8")
export const shellFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const traceLines = (text: string): ReadonlyArray<TraceLine> =>
  text
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))(line))

export const trace = runnerFixture("agent-tree.trace.jsonl")
export const lines = traceLines(trace)
export const steps = stepsOfTrace(lines)
export const start = emptyTree({
  title: "epic conto-bonifico",
  stories: [
    { id: "accounts", status: "done" },
    { id: "payments", status: "active" },
    { id: "iban", status: "failed" },
    { id: "overview", status: "active" },
    { id: "movimenti", status: "planned" },
    { id: "bonifico", status: "waiting" }
  ]
})

/** The frame after every step up to and including `seq`. */
export const frameAt = (seq: number): WebFrame =>
  frameOf(
    foldSteps(
      start,
      steps.filter((step) => step.seq <= seq)
    ),
    { steps: steps.length, lastSeq: 50 }
  )

/** The frame after the first `count` steps, as `/api/frame?count=` serves it. */
export const frameAfter = (count: number, gapMs = 0): WebFrame =>
  frameOf(foldSteps(start, steps.slice(0, count)), { steps: steps.length, lastSeq: 50, gapMs })

/** The clones fixture (ADR 0033): clones, task plans, parallel task coders; the boards golden's run. */
export const clonesStart = emptyTree({ title: "epic bank-login" })
export const clonesSteps = stepsOfTrace(traceLines(runnerFixture("agent-tree.clones.trace.jsonl")))
export const clonesFrame = (): WebFrame =>
  frameOf(foldSteps(clonesStart, clonesSteps), {
    steps: clonesSteps.length,
    lastSeq: clonesSteps.at(-1)?.seq
  })
