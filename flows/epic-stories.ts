// Split an epic into stories with a declared dependency graph, approve the plan, then implement the stories with parallel coders in per-story worktrees merged into an epic branch.
//
//   llm4ts run epic-stories --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-stories --repo ~/demo/portal -- --plan-only "…"   # write the plan and stop
//   llm4ts run epic-stories --repo ~/demo/portal -- --land            # land the finished epic on main
//   llm4ts run epic-stories --repo ~/demo/portal -- --list            # the repository's epics
//   llm4ts run epic-stories --repo ~/demo/portal -- --epic <id>       # resume one, no text needed
//
// The reasoning seat (LLM4TS_REASONER, default claude) splits the epic,
// reviews every task and judges every story; the coder seat (LLM4TS_CODER,
// default pi) implements; LLM4TS_CODER_MODEL / LLM4TS_REASONING_MODEL pick
// their models (pi: "provider/model"). The story plan is persisted under
// .llm4ts/epics/<epic-id>/plan.md BEFORE any coder runs, and an existing
// file wins over regeneration — editing it is the approval and the re-plan
// path. Stories run in worktrees BESIDE the repository (<repo>.worktrees/
// <epic-id>/<story-id>, LLM4TS_WORKTREE_ROOT to move them) under
// --concurrency (default 3); a failed story puts its dependents on hold
// (--fail-fast stops instead). The epic branch is left in place; the board
// and the report under .llm4ts/epics/<epic-id>/ carry ESTIMATED usage
// figures (ADR 0013).
// Transcripts (what each seat was told and answered) are ON by default for
// this flow — LLM4TS_TRANSCRIPT=off turns them off — and --land compacts them
// (shape kept, content removed) rather than deleting them (ADR 0025).
import { runFlowMain } from "@llm4ts/runner"
import { rubricStoryJudge, runEpicStories } from "./lib/epic-stories.ts"

runFlowMain(runEpicStories({ storyJudge: rubricStoryJudge }))
