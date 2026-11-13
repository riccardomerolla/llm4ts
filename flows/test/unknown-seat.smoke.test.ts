import { describe, it, assert } from "@effect/vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { unreadableInEnvironment } from "@llm4ts/flow/Settings"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  write
} from "./support/smoke.ts"

const kit = "../kits/j2ee-nextjs/flows"

const coderFlows = [
  "implement",
  "issue-pr",
  "judge-suite",
  "sdd",
  "pack-fork",
  "modernize-bench",
  "modernize-extract",
  "modernize-implement",
  "modernize-refine",
  "modernize-review",
  "modernize-seed",
  "modernize-survey",
  "modernize-verify",
  "port-compile",
  "port-files",
  "port-guide",
  "port-ledger",
  "port-tests",
  "epic-stories",
  "epic-draft",
  "epic-mvp",
  "epic-stories-board",
  "taskforce",
  `${kit}/convert-all`,
  `${kit}/convert-feature`,
  `${kit}/convert-page`
]

const reasonerFlows = ["epic-stories", "epic-design", "roundtable", "taskforce"]

const tasks: Readonly<Record<string, string>> = { "issue-pr": "owner/repository#42" }

const needs: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "pack-fork": { LLM4TS_TARGET_KIND: "frontend", LLM4TS_FORK_AS: "acme-next" },
  "epic-mvp": { LLM4TS_TEST_ONE: "sh scripts/test.sh {tag}" },
  "epic-design": { LLM4TS_LEGACY_REPO: "legacy" }
}

// The runner refuses the name before the flow reads its seats, as `llm4ts run` does.
const refusal = unreadableInEnvironment

const runWith = (flow: string, environment: Readonly<Record<string, string>>) => {
  const fixture = makeFixture()
  initRepo(fixture.target)
  write(fixture.target, "README.md", "# target\n")
  commitAll(fixture.target, "init")
  const called = join(fixture.root, "stub-called")
  installStub(
    fixture,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(called)}, "")\nprocess.exit(1)\n`
  )
  const result = runFlow(
    fixture,
    flow,
    fixture.target,
    { ...needs[flow], ...environment },
    tasks[flow] ?? "Do the thing"
  )
  return { result, fixture, called }
}

describe("a flow refuses a seat name it does not know", () => {
  it(
    "the marker sees a run that does start",
    () => {
      const { fixture, called } = runWith("implement", { LLM4TS_CODER: "claude" })

      assert.isTrue(existsSync(called))
      assert.isTrue(existsSync(join(fixture.target, ".llm4ts")))
    },
    smokeTimeout
  )

  // Since 4.0.0 an unreadable value stops every launch, as the shell's does:
  // `implement` runs no reasoning seat and still refuses a bad LLM4TS_REASONER.
  it(
    "a flow refuses a name even for a seat it never uses",
    () => {
      const { result, called } = runWith("implement", {
        LLM4TS_CODER: "claude",
        LLM4TS_REASONER: "codx"
      })

      assert.strictEqual(result.status, 1, failureReport("implement", result))
      assert.include(result.stderr, refusal("LLM4TS_REASONER"), failureReport("implement", result))
      assert.isFalse(existsSync(called), "the stub agent was started")
    },
    smokeTimeout
  )

  it.each(coderFlows)(
    "%s stops on an unknown LLM4TS_CODER before any agent starts",
    (flow) => {
      const { result, fixture, called } = runWith(flow, { LLM4TS_CODER: "codx" })

      assert.strictEqual(result.status, 1, failureReport(flow, result))
      assert.include(result.stderr, refusal("LLM4TS_CODER"), failureReport(flow, result))
      assert.isFalse(existsSync(called), "the stub agent was started")
      assert.isFalse(existsSync(join(fixture.target, ".llm4ts")), "a run started")
    },
    smokeTimeout
  )

  it.each(reasonerFlows)(
    "%s stops on an unknown LLM4TS_REASONER before any agent starts",
    (flow) => {
      const { result, called } = runWith(flow, { LLM4TS_REASONER: "codx" })

      assert.strictEqual(result.status, 1, failureReport(flow, result))
      assert.include(result.stderr, refusal("LLM4TS_REASONER"), failureReport(flow, result))
      assert.isFalse(existsSync(called), "the stub agent was started")
    },
    smokeTimeout
  )
})
