// Reach an epic's MVP sooner, test-first: the planner cuts each story to its MVP outcomes and parks the rest, every story writes its red tests before any code, and green tests replace the review lenses and the story judge (ADR 0042).
//
//   llm4ts run epic-mvp --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-mvp --repo ~/demo/portal -- --plan-only "…"   # write the MVP cut and stop
//   llm4ts run epic-mvp --repo ~/demo/portal -- --land            # land once the MVP is reached
//   llm4ts run epic-mvp --repo ~/demo/portal -- --iterate         # plan the parked items next
//   llm4ts run epic-mvp --repo ~/demo/portal -- --review "…"      # one review lens per task back
//
// Same seats, flags and environment as epic-stories, plus the per-test
// evidence each MVP outcome needs: LLM4TS_TEST_REPORT (the JUnit XML report
// the test gate writes, relative to the app directory) or LLM4TS_TEST_ONE
// (one command per outcome, `{tag}`/`{tagRegex}` replaced by its tag). The
// plan at .llm4ts/epics/<epic-id>/plan.md holds each story's MVP outcomes in
// `acceptance` and the cut ones in `later`; stories cut whole are in
// mvp-cut.json. After a run, parked.md lists what is left and mvp.json says
// whether the MVP is reached; --land refuses until it is.
import { runFlowMain } from "@llm4ts/runner"
import { epicMvpOptions, parseMvpFlags } from "./lib/epic-mvp.ts"
import { runEpicStories } from "./lib/epic-stories.ts"

const flags = parseMvpFlags(process.argv.slice(2))

runFlowMain(runEpicStories({ ...epicMvpOptions(flags, process.env), argv: flags.argv }))
