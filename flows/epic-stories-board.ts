// A fork of epic-stories that judges each story with a blackboard ruleset (ADR 0020): the four story dimensions are scored by the Judgment service, decided by the run's judgment policy, and a company-editable bar in flows/lib/story-board.ts says whether the story merges. Same flags and environment as epic-stories.
//
//   llm4ts run epic-stories-board --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-stories-board --repo ~/demo/portal -- --plan-only "…"
//
// The judgment seat is LLM4TS_JUDGMENT_PROVIDER / LLM4TS_JUDGMENT_MODEL (ADR
// 0017), or one derived from the reasoning seat. Each round's run lands in
// the trace as a BlackboardRun event and each answer in
// .llm4ts/judgments/story-board.jsonl. Until this judge is approved,
// epic-stories keeps the rubric judge.
import { runFlowMain } from "@llm4ts/runner"
import { runEpicStories } from "./lib/epic-stories.ts"
import { boardJudgeFactory } from "./lib/story-board.ts"

runFlowMain(
  runEpicStories({
    storyJudge: boardJudgeFactory,
    judgmentFromEnvironment: true,
    judgmentLog: true
  })
)
