import { readFileSync, writeFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  emptyTree,
  initialView,
  reduceTree,
  renderTree,
  treeInputsOfTrace,
  type TreeInput,
  type TreeState
} from "@llm4ts/runner/AgentTree"
import type { Verbosity } from "@llm4ts/runner/EventPresentation"
import { summarizeTree } from "@llm4ts/runner/RunSummary"
import {
  consumeTerminalEvents,
  plainTerminalPalette,
  type TerminalSurface
} from "@llm4ts/runner/Terminal"

/**
 * What each run view prints for the same recorded runs, pinned byte for byte:
 * the terminal at every verbosity, the agent tree, and the run summary.
 * `UPDATE_GOLDENS=1` rewrites the files under `fixtures/run-views/`.
 */

const traces = ["agent-tree", "agent-tree.clones", "run-views"] as const

const fixture = (path: string): string =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8")

const golden = (name: string, text: string): void => {
  const path = `run-views/${name}.txt`
  if (process.env.UPDATE_GOLDENS === "1") {
    writeFileSync(new URL(`./fixtures/${path}`, import.meta.url), text)
  }
  assert.strictEqual(text, fixture(path))
}

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))

const traceLines = (trace: string): ReadonlyArray<TraceLine> =>
  fixture(`${trace}.trace.jsonl`)
    .trim()
    .split("\n")
    .map((line) => decodeLine(line))

const inputsOf = (trace: string): ReadonlyArray<TreeInput> => treeInputsOfTrace(traceLines(trace))

const folded = (trace: string): TreeState =>
  inputsOf(trace).reduce(reduceTree, emptyTree({ title: trace }))

/** Every log line, and the status block whenever it changed, as the events arrive on their timestamps. */
const terminalTranscript = (trace: string, verbosity: Verbosity) =>
  Effect.scoped(
    Effect.gen(function* () {
      const out: Array<string> = []
      let status: string | undefined
      const surface: TerminalSurface = {
        palette: plainTerminalPalette,
        log: (line) => Effect.sync(() => out.push(line)),
        setStatus: (label) =>
          Effect.sync(() => {
            status = label
          }),
        suspend: (effect) => effect
      }
      // The consumer's one-second ticker wakes once per simulated second: start
      // the clock at the run, not at the epoch.
      yield* TestClock.setTime(inputsOf(trace)[0]?.at ?? 0)
      const hub = yield* makeFlowEventHub()
      const consumer = yield* consumeTerminalEvents(hub, surface, verbosity, { timestamps: true })
      let shown: string | undefined
      for (const input of inputsOf(trace)) {
        yield* TestClock.setTime(input.at)
        if (input._tag !== "Event") {
          continue
        }
        yield* hub.publish(input.event)
        yield* consumer.awaitDrained()
        if (status !== shown) {
          shown = status
          out.push(...(status ?? "(none)").split("\n").map((row) => `  status | ${row}`))
        }
      }
      const stats = yield* consumer.stats
      out.push(`stats: ${stats.stagesCompleted} completed, ${stats.stagesFailed} failed`)
      return `${out.join("\n")}\n`
    })
  )

describe("run views over recorded traces", () => {
  it("decodes every event line of the fixtures", () => {
    for (const trace of traces) {
      const lines = traceLines(trace).filter((line) => line.kind !== "RawLine")
      assert.strictEqual(inputsOf(trace).length, lines.length, trace)
    }
  })

  for (const trace of traces) {
    for (const verbosity of ["Quiet", "Normal", "Verbose", "Debug"] as const) {
      it.effect(`terminal: ${trace} at ${verbosity}`, () =>
        Effect.map(terminalTranscript(trace, verbosity), (text) =>
          golden(`${trace}.terminal-${verbosity.toLowerCase()}`, text)
        )
      )
    }

    it(`agent tree: ${trace}`, () => {
      const state = folded(trace)
      for (const mode of ["lanes", "executors", "boards"] as const) {
        const view = { ...initialView, mode }
        golden(
          `${trace}.tree-${mode}-100`,
          `${renderTree(state, { width: 100, colour: false, view }).join("\n")}\n`
        )
      }
    })

    it(`run summary: ${trace}`, () => {
      const state = folded(trace)
      golden(
        `${trace}.summary`,
        `${summarizeTree(state, undefined)}\n${summarizeTree(state, "epic-stories")}\n`
      )
    })
  }
})
