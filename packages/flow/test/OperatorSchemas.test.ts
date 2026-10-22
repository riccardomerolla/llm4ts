import { assert, describe, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  OperatorKnobs,
  OperatorRun,
  encodeOperatorRunLine,
  latestRuns
} from "@llm4ts/flow/OperatorSchemas"

const run = (runId: string, state: OperatorRun["state"], startedAt: number): OperatorRun =>
  OperatorRun.make({
    runId,
    repo: "/repo",
    flow: "epic-stories",
    args: [],
    knobs: {},
    startedAt,
    logDir: "/state/logs",
    state
  })

describe("OperatorSchemas", () => {
  it("latestRuns keeps the last record per run, newest first, and skips a torn line", () => {
    const lines = [
      encodeOperatorRunLine(run("run-1", "starting", 1)),
      encodeOperatorRunLine(run("run-1", "running", 1)),
      encodeOperatorRunLine(run("run-1", "exited", 1)),
      encodeOperatorRunLine(run("run-2", "running", 2)),
      '{"runId":"torn"'
    ]
    assert.deepStrictEqual(latestRuns(lines), [
      run("run-2", "running", 2),
      run("run-1", "exited", 1)
    ])
  })

  it("OperatorKnobs round-trips with every field optional", () => {
    const decode = Schema.decodeUnknownOption(OperatorKnobs)
    assert.isTrue(Option.isSome(decode({})))
    const full = {
      task: "t",
      epic: "e",
      pack: "p",
      executors: ["pi"],
      coder: "claude",
      judgeRounds: 2,
      mergeRevisions: 1,
      land: "main",
      flags: ["--refine"],
      requestId: "r"
    }
    const encoded = Schema.encodeSync(OperatorKnobs)(full)
    assert.deepStrictEqual(Schema.decodeUnknownSync(OperatorKnobs)(encoded), full)
  })
})
