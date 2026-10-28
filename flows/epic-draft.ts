// Working code first, tests and validation later: the planner cuts stories without tests, coders build under one review lens and the build gates, and what was deferred is written as debt that --harden plans under the full bar (ADR 0043).
//
//   llm4ts run epic-draft --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-draft --repo ~/demo/portal -- --plan-only "…"   # write the draft plan and stop
//   llm4ts run epic-draft --repo ~/demo/portal -- --harden          # write the tests owed, close findings
//   llm4ts run epic-draft --repo ~/demo/portal -- --land            # land, hardened or not
//
// Same seats, flags and environment as epic-stories, plus --with-tests to
// keep the test gate while drafting. After a draft run, debt.md beside the
// plan lists each merged story's tests owed, its deferred findings and the
// test gate's failures on the epic checkout; a settled --harden round moves
// what it paid to debt.paid.md.
import { runFlowMain } from "@llm4ts/runner"
import { epicDraftOptions, parseDraftFlags } from "./lib/epic-draft.ts"
import { runEpicStories } from "./lib/epic-stories.ts"

const flags = parseDraftFlags(process.argv.slice(2))

runFlowMain(runEpicStories({ ...epicDraftOptions(flags), argv: flags.argv }))
