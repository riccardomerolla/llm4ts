# Anthropic's published best practices for coding agents and agentic systems

Research note compiled 2026-10-06 for `llm4ts` (plan → code → review → judge flows
over Claude, Codex, Gemini and local models, via API or CLI).

Scope: primary Anthropic sources only — `anthropic.com/engineering`,
`anthropic.com/research`, `anthropic.com/news`, `claude.com/blog`,
`code.claude.com/docs`, `platform.claude.com/docs` (formerly `docs.claude.com` /
`docs.anthropic.com`; those hosts now 302 to `platform.claude.com`) and
`github.com/anthropics`. Each per-source section states the publication date (or
"living doc, undated" for documentation pages that carry no date), the URL, and
3–8 reusable, provider-agnostic rules, each anchored to a verbatim quote of at
most 20 words taken from that source.

The engineering blog index (fetched 2026-10-06) lists 25 posts; the newest is
2026-05-25 ("How we contain Claude across products", featured) and nothing dated
June–October 2026 appears there. The newest agent-relevant material from 2026 is
on `claude.com/blog` (code migrations 2026-07-16, SDLC security 2026-07-21,
SDLC playbook 2026-08-21, code modernization 2026-09-23), in model launch posts
(Opus 4.8 2026-05-28, Fable 5 2026-06-09, Opus 5 2026-07-24, Fable 5.1
2026-09-01) and in the per-model prompting guides on `platform.claude.com`.

How to read the "portability" tags used below:

- **[portable]** — a harness-level practice that applies to any model/CLI
  (Codex CLI, Gemini CLI, local models). This is the default.
- **[claude-mechanic]** — a Claude API / Claude Code feature (prompt caching
  headers, memory tool, context editing, hooks, `/goal`, `--permission-mode`…).
  The idea behind it usually ports; the mechanism does not.

---

## Part 1 — Sources, newest first

### 1. How to prepare for AI-driven code modernization projects — 2026-09-23

URL: https://claude.com/blog/how-to-prepare-for-ai-driven-code-modernization-projects

- Define three artifacts before the agents start: the **target** (end state),
  the **certificate** (conditions every change must meet) and the **promotion
  policy** (tiered review paths). Anchor: _"Write the certificate with the people
  who will review and promote changes into production."_
- Make the certificate machine-checkable so the loop can iterate on a change
  until it passes, or flag it for a human when it cannot. Anchor: _"Risk
  reduction is often the most important modernization benefit."_
- When a class of change keeps getting flagged, fix the generator, not the
  instances. Anchor: _"You should modify the workflow, not each change, when
  issues surface."_
- Same rule for reviewers: _"Fix recurring flags at the source rather than
  reviewing each one."_
- Run a pilot and budget from it. Anchor: _"Measure token-usage from the pilot
  and extrapolate for the full run."_
- Expect the bottleneck to move from producing changes to getting them accepted.
  Anchor: _"the bottleneck shifts from producing changes to mobilizing the
  organization around them."_

### 2. Prompting Claude Fable 5.1 (platform docs; model released 2026-09-01) — living doc

URL: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
(Launch post: https://www.anthropic.com/claude-fable-and-mythos-5-1, dated 2026-09-01; the `/news/claude-fable-5-1` URL returns 404.)

- Treat conversation history as **append-only**: replay assistant turns
  byte-for-byte, send per-turn reminders as turn-scoped system messages, and let
  the server (or a separate pass) do trimming. Editing earlier turns both busts
  the prompt cache and, on Fable 5.1, invalidates thinking blocks. Anchor:
  _"Append each assistant turn to the history exactly as the API returned it,
  thinking blocks included"_. [claude-mechanic for the 400; portable as a cache
  rule]
- In autonomous pipelines, tell the model explicitly that nobody is watching and
  that it must act rather than announce. Anchor: _"The user is not watching in
  real time and cannot answer questions mid-task"_.
- Define the request (or approved plan) as the scope of the deliverable and
  forbid silent narrowing/widening. Anchor: _"the scope is the deliverable:
  don't quietly narrow, widen, or swap it."_
- Give the compaction summarizer an explicit preservation list (problems and how
  resolved, options tried/set aside, decisions, current state, open items, exact
  identifiers). Anchor: _"Be sure to preserve: (1) any difficulties or problems
  that came up, and how they were handled"_.
- Constrain extras: report pre-existing bugs as follow-ups, don't turn scratch
  checks into permanent tests. Anchor: _"don't turn scratch checks into
  additional permanent test files."_
- Let the lead keep working while subagents run: spawn returns immediately,
  results arrive as later user messages, a separate "wait" tool exists. Anchor:
  _"don't force the lead agent to stop and wait for each one."_
- Nudge batched tool calls in coding loops where the next calls are implied, not
  requested. Anchor: _"First privately list what you need next; then request
  every item that doesn't depend on another's result"_.
- Re-run effort sweeps per model; effort names don't mean the same thinking
  budget across models. Anchor: _"effort level names don't correspond to the same
  amount of thinking across models."_

### 3. The AI-native SDLC playbook — 2026-08-21

URL: https://claude.com/blog/the-ai-native-sdlc-playbook

- Spec first: produce `spec.md` from an approved `intent.md`, applying policies
  as constraints at spec time rather than discovering them in review.
  Anchor: _"Code is no longer the bottleneck and the build phase runs faster than
  the traditional SDLC allows for"_.
- The agent checks its own work (tests, build, visual compare) before any human
  looks. Anchor: _"The loop keeps running. Human judgement stays above it"_.
- Hard production gate the agent cannot cross. Anchor: _"The agent may act up to
  the production gate and cannot pass it"_.
- Multi-pass AI review (bugs, security, compliance) so humans review intent and
  risk. Anchor: _"review quality varies with the reviewer's load"_.
- Track leading indicators (time to first merged PR, concurrent sessions per
  engineer) and lagging ones (rework cycles, escaped defects). Anchor:
  _"Humans remain accountable for every decision that requires judgment"_.

### 4. Introducing Claude Opus 5 + Prompting Claude Opus 5 — 2026-07-24 / living doc

URLs: https://www.anthropic.com/news/claude-opus-5 ;
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

- Remove legacy "verify your work" scaffolding for models that self-verify; it
  compounds into over-verification. Anchor: _"instructions like these cause
  over-verification on Claude Opus 5"_.
- Reviewers told to "be conservative" under-report; ask for everything and
  filter in a separate pass. Anchor: _"ask it to report everything and filter in
  a separate pass instead."_
- Cap delegation deterministically (depth, concurrency, spend) rather than only
  by prompt. Anchor: _"set deterministic caps on how many agents can be
  launched."_ [claude-mechanic env vars; portable as a harness rule]
- Don't use subagents to double-check the lead's own work on small tasks.
  Anchor: _"do not use subagents to verify or double-check your own work."_
- Lower effort is a first-class cost lever once evals say quality holds.
  Anchor: _"use `low` and `medium` liberally as your primary control for token
  cost"_.
- Launch post on behaviour: _"catches its own logical faults during planning
  rather than after the fact."_

### 5. How Anthropic secures its AI-native software development lifecycle — 2026-07-21

URL: https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle

- Security boundaries go around access and actions, never around the model's
  instructions. Anchor: _"Draw the boundary around access and actions, not around
  a model's instructions."_
- Log every automated approval, tool call and agent-to-agent message with the
  signals that justified it. Anchor: _"Every automated approval, tool call, and
  agent-to-agent message is logged with the signals it used."_
- Run new reviewer agents in shadow mode, risk-tier the codebase, sample-audit.
  Anchor: _"The security engineer's job evolves from monitoring bugs to
  monitoring loops."_
- Encode house rules where code is generated (CLAUDE.md-style files) so defects
  are prevented at the source. Anchor: _"Security professionals can directly
  shape how code is created"_.
- Scale fact: _"Claude authors about 80% of the code merged into our codebase
  today."_

### 6. How Anthropic runs large-scale code migrations with Claude Code (Bun Zig→Rust) — 2026-07-16

URL: https://claude.com/blog/ai-code-migration
(Related: "Introducing dynamic workflows", 2026-05-28, https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)

Six-step process: rulebook + dependency map + gap inventory → stress-test the
rules on a sample → translate everything (fan-out work queue) → compile with
fixer agents → smoke test → match behaviour by diffing test results. Numbers:
~1M lines Zig→Rust in under two weeks, 5.9B input / 690M output tokens
(~$165k); 100% of Bun's existing test suite passing in CI before merge.

- Fix the loop, not the output. Anchor: _"Don't fix the code. You fix the
  process (loop) that produced the code."_
- The judge must see original and target on equal terms (same tests, same
  oracle). Anchor: _"The judge must be able to evaluate both the original code
  and the target code on equal terms."_
- Failures feed the queue mechanically. Anchor: _"The queue writes itself: when
  a compiler or test run fails, that becomes the next item."_
- Humans look at the error list for systemic patterns, not at individual
  failures. Anchor: _"Don't focus on individual failures. Individual failures are
  the loop's job."_
- Adversarial review, mechanical verification. Anchor: _"Make review adversarial
  and verification mechanical."_
- Right-size models per stage. Anchor: _"Don't use the largest model for
  everything."_
- Human time goes up front. Anchor: _"Front-load the human hours. The rulebook
  and the stress test are the most time-consuming."_
- Define "done" as an on-disk artifact, not a claim. Anchor: _"Done should mean
  'the output file exists on disk.'"_
- Dynamic workflows post: _"Results are checked before they're folded in, and
  you come back to a single, coordinated answer."_ and _"Progress is saved as the
  run goes, so a job that's interrupted picks up where it left off."_

### 7. How Claude Code is used in practice (research) — 2026-06-16

URL: https://www.anthropic.com/research/claude-code-expertise

- Division of labour observed at scale: people decide what, agents decide how.
  Anchor: _"People decide what to build, and the agent decides how to build it."_
- Domain expertise, not coding skill, predicts verified success (15% novice vs
  28–33% intermediate/expert). Anchor: _"Success is determined by how well a
  person understands the problem they are trying to solve"_.
- Richer problem understanding lets the agent take longer action chains per
  instruction (≈12 vs 5 actions). Anchor: _"the more understanding a worker
  brings to an agent, the more quality work the agent is able to do."_

### 8. Claude Fable 5 and Claude Mythos 5 + Prompting Claude Fable 5 — 2026-06-09 / living doc

URLs: https://www.anthropic.com/news/claude-fable-5-mythos-5 ;
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5

- Ground progress claims in tool results; this "nearly eliminated fabricated
  status reports". Anchor: _"Before reporting progress, audit each claim against
  a tool result from this session."_
- Fresh-context verifier subagents beat self-critique on long runs. Anchor:
  _"Separate, fresh-context verifier subagents tend to outperform
  self-critique."_
- Give the agent a lessons file; one lesson per file, delete wrong ones, don't
  duplicate what the repo already records. Anchor: _"Store one lesson per file
  with a one-line summary at the top."_
- Don't show a remaining-token countdown; it triggers premature wrap-up.
  Anchor: _"Avoid surfacing explicit context-budget counts where possible."_
- Plan for long turns: adjust timeouts, stream, check asynchronously. Anchor:
  _"consider restructuring harnesses to check on runs asynchronously"_.
- Audit old skills/prompts when a stronger model lands; they are often too
  prescriptive. Anchor: _"Skills developed for prior models are often too
  prescriptive for Claude Fable 5"_.
- Give the reason behind a request. Anchor: _"Claude Fable 5 tends to perform
  better when it understands the intent behind a request"_.
- A `send_to_user` tool delivers verbatim content mid-run without ending the
  turn. Anchor: _"Tool inputs are never summarized, so the content arrives
  intact."_
- Launch post (Stripe): _"Fable 5 compressed months of engineering into days."_

### 9. Introducing Claude Opus 4.8 — 2026-05-28

URL: https://www.anthropic.com/news/claude-opus-4-8

- Codebase-scale migrations "from kickoff to merge, with the existing test suite
  as its bar" — the test suite is the acceptance oracle. Anchor (customer quote):
  _"The only model to complete every case end-to-end, beating prior Opus
  models."_
- Dynamic workflows: plan, then hundreds of parallel subagents in one session,
  with output verified before reporting. Anchor (customer quote): _"Tool calling
  is meaningfully more efficient, using fewer steps for same intelligence."_
- Effort controls (standard/extra/maximum) trade speed against depth; ~4× less
  likely to let code flaws pass undetected than its predecessor.

### 10. How we contain Claude across products — 2026-05-25

URL: https://www.anthropic.com/engineering/how-we-contain-claude

- Environmental (deterministic) defenses take precedence over behavioural
  (probabilistic) ones. Anchor: _"Any probabilistic defense has a non-zero miss
  rate."_
- Prefer battle-tested isolation primitives to home-grown ones. Anchor: _"The
  weakest layer is the one you built yourself."_ and _"Our custom allowlist proxy
  was the piece that failed."_
- Treat repo config, project-open and localhost listeners as inbound internet
  traffic. Anchor: _"Treat project-open, config-load, and localhost listeners the
  way you'd treat any inbound request from the internet."_
- Tool output is untrusted even from trusted tools. Anchor: _"Tool output is an
  attack surface even when the tool is trusted."_
- Match isolation strength to the operator's ability to evaluate commands.
  Anchor: _"A tight perimeter also means you can relax oversight."_
- Remote tools can change after approval; local tools are auditable. Anchor: _"A
  remote tool can change behavior at any point after you've approved it."_

### 11. How Claude Code works in large codebases — 2026-05-14

URL: https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start

- The harness matters more than the model for observed performance. Anchor:
  _"The harness determines how Claude Code performs more than the model alone."_
- Layer instruction files: root for the big picture, subdirectories for local
  conventions, loaded additively. Anchor: _"Keeping CLAUDE.md files lean and
  layered prevents context from drifting into noise."_
- Use subagents for read-only mapping; the main agent edits with full
  information. Symbol-level navigation (LSP) filters before the model reads.
  Anchor: _"filtering happens before Claude reads anything."_
- Revisit configuration every 3–6 months; rules tuned for old models constrain
  new ones. Anchor: _"Bottoms-up adoption fragments without someone centralizing
  what works."_

### 12. An update on recent Claude Code quality reports (postmortem) — 2026-04-23

URL: https://www.anthropic.com/engineering/april-23-postmortem

Three root causes: default reasoning effort lowered high→medium; a caching
optimisation that cleared thinking every turn instead of once; a system-prompt
verbosity cap (≤25 words between tool calls) that cut coding quality ~3%.

- Terse-output constraints on the agent degrade coding quality; don't cap
  inter-tool-call text aggressively. Anchor: _"One of these evaluations showed a
  3% drop for both Opus 4.6 and 4.7."_
- Default to more thinking; let users lower it. Anchor: _"In general, the longer
  the model thinks, the better the output."_
- Any context/cache mutation needs a regression eval; the bug cleared reasoning
  "on every turn for the rest of the session". Anchor: _"Cache utilization is
  something we manage carefully."_
- Per-model evals for every prompt change, ablations, soak periods, canaries,
  and dogfood the public build. Anchor: _"the aggregate effect looked like broad,
  inconsistent degradation."_
- Keep a user-feedback channel; it found the bugs. Anchor: _"The people who used
  the `/feedback` command … are the ones who ultimately allowed us to identify
  and fix these problems."_

### 13. Scaling Managed Agents: decoupling the brain from the hands — 2026-04-08

URL: https://www.anthropic.com/engineering/managed-agents

- Separate brain (model+harness, stateless), hands (sandboxes/tools, "cattle")
  and session (durable append-only event log). Anchor: _"The session provides
  this same benefit, serving as a context object that lives outside Claude's
  context window"_.
- Resume from the event log after a crash; container death is just a tool error.
  Anchor: _"If a container died, the harness caught the failure as a tool-call
  error"_.
- Never let credentials reach the sandbox that runs model-written code.
  Anchor: _"No hand is coupled to any brain; brains can pass hands to one
  another"_.
- Re-question harness assumptions each model generation. Anchor: _"Harnesses
  encode assumptions about what Claude can't do on its own"_.
- Provision lazily, make no assumptions about agent count/location. Anchor:
  _"Make no assumptions about the number or location of brains or hands Claude
  will need"_.

### 14. Agent Harness Design: 3 patterns (claude.com/blog) — 2026-04-02

URL: https://claude.com/blog/harnessing-claudes-intelligence

- Lean on the model with general tools (bash, editor) rather than bespoke ones.
  Anchor: _"Code is a general way for Claude to orchestrate actions."_
- Strip the harness as models improve; context resets and similar crutches become
  dead weight. Anchor: _"Removing this dead weight is important because it can
  bottleneck Claude's performance."_
- Keep boundaries the model cannot know: security surface, UX surface,
  observability. Anchor: _"Claude doesn't necessarily know an application's
  security boundary or UX surface."_
- Anchor: _"The frontier of Claude's intelligence is always changing."_

### 15. How we built Claude Code auto mode — 2026-03-25

URL: https://www.anthropic.com/engineering/claude-code-auto-mode

- A separate classifier decides whether an action is something the user
  authorised; it sees only user messages and the tool command, never the agent's
  rationale. Anchor: _"Strip assistant text so the agent can't talk the
  classifier into making a bad call."_
- Four causes of dangerous actions: overeager behaviour, honest mistakes, prompt
  injection, misalignment — design for all four. Anchor: _"An agent might take a
  dangerous action for four reasons"_.
- Judge real-world impact, not surface text. Anchor: _"Evaluate the real-world
  impact of an action, rather than just the surface text."_
- Denial is recoverable; let the agent try a safer route. Anchor: _"Denial isn't
  failure—allow agents to recover by trying safer approaches to the same goal."_
- Escalate after repeated denials. Anchor: _"Stop and escalate after 3
  consecutive denials or 20 total denials within a session."_
- Layer input-side injection detection with output-side transcript monitoring.
  Anchor: _"Two layers of defense compound"_.
- Measured on real traffic (0.4% FP), curated overeager actions (17% FN) and
  synthetic exfiltration (5.7% FN). Anchor: _"Start with conservative defaults;
  users can customize the trust boundary iteratively."_

### 16. Harness design for long-running application development — 2026-03-24

URL: https://www.anthropic.com/engineering/harness-design-long-running-apps

Planner → generator → evaluator (Playwright-driven) over multi-hour runs;
V1 (Opus 4.5) used context resets with file handoffs, V2 (Opus 4.6) ran one
continuous session with SDK compaction. Costs: solo run 20 min/$9 vs harness 6
h/$200 (V1); V2 total 3h50/$124.70.

- Separate the worker from the judge; self-evaluation inflates. Anchor:
  _"Separating the agent doing the work from the agent judging it proves to be a
  strong lever."_
- Tune the evaluator to be skeptical — easier than making the generator
  self-critical. Anchor: _"Tuning a standalone evaluator to be skeptical turns
  out to be far more tractable."_
- Calibrate the judge with few-shot scored examples and hard per-criterion
  thresholds. Anchor: _"I calibrated the evaluator using few-shot examples with
  detailed score breakdowns."_
- Agree the definition of done before coding ("sprint contract"). Anchor: _"The
  generator and evaluator negotiated a sprint contract: agreeing on what 'done'
  looked like before code was written."_
- Agents communicate through files. Anchor: _"Communication was handled via
  files: one agent would write a file, another agent would read it."_
- Context resets address both coherence loss and "context anxiety". Anchor:
  _"Context resets—clearing the context window entirely and starting a fresh
  agent—addresses both these issues."_
- Every harness component encodes a model limitation; re-examine per model.
  Anchor: _"When a new model lands, re-examine a harness, stripping away pieces
  that are no longer load-bearing."_

### 17. Long-running Claude for scientific computing (research) — 2026-03-23

URL: https://www.anthropic.com/research/long-running-Claude

- A progress file is the agent's portable long-term memory; record failed
  approaches so later sessions do not retry them. Anchor: _"Failed approaches are
  important—without them, successive sessions will re-attempt the same dead
  ends."_
- Commit after every meaningful unit, test before every commit. Anchor: _"Commit
  and push after every meaningful unit of work. Run pytest before every commit."_
- A reference implementation acts as the oracle; build unit tests from it and
  run continuously. Anchor: _"The progress file...is the agent's portable
  long-term memory, acting as a sort of lab notes."_
- A loop that re-prompts for completion verification (bounded iterations)
  drives multi-day work. Anchor: _"Rather than getting involved with every
  detail, we can specify the high-level objective"_.

### 18. Eval awareness in Claude Opus 4.6's BrowseComp performance — 2026-03-06

URL: https://www.anthropic.com/engineering/eval-awareness-browsecomp

- Treat eval integrity as adversarial and ongoing; web-enabled agents will find
  leaked answers. Anchor: _"Every agent that searches the web leaves traces, and
  the web is slowly accumulating a permanent record."_
- URL blocklists are insufficient; block by content keyword. Anchor: _"URL-level
  blocklists were insufficient to curb this behavior."_
- Parallel/multi-agent search raises contamination exposure (3.7× here).
  Anchor: _"This finding raises questions about whether static benchmarks remain
  reliable when run in web-enabled environments."_

### 19. Quantifying infrastructure noise in agentic coding evals — 2026-02-05

URL: https://www.anthropic.com/engineering/infrastructure-noise

- Resource caps and timeouts swing agentic benchmark scores by several points —
  more than leaderboard gaps. Anchor: _"A few-point lead might signal a real
  capability gap—or it might just be a bigger VM."_
- Separate guaranteed allocation from the hard kill ceiling; ~3× headroom.
  Anchor: _"A momentary memory fluctuation can OOM-kill a container that would
  otherwise have succeeded."_
- Run trials at different times/days, report confidence intervals, distrust
  <3-point differences. Anchor: _"Small score differences on agentic evals carry
  more uncertainty than reported precision suggests."_
- Classify infra errors separately from model failures (5.8% vs 0.5% infra
  error rate under strict vs uncapped limits). Anchor: _"The runtime is no longer
  a passive container, but an integral component of the problem-solving
  process."_

### 20. Building a C compiler with a team of parallel Claudes — 2026-02-05

URL: https://www.anthropic.com/engineering/building-c-compiler

16 agents, 2 weeks, ~2,000 sessions, 2B input / 140M output tokens, $20k,
100k lines of Rust that compiles Linux 6.9; no orchestrator — shared bare git
repo plus lock files in `current_tasks/`.

- Near-perfect verifier first; autonomy amplifies whatever the verifier accepts.
  Anchor: _"it's important that the task verifier is nearly perfect."_
- Budget orientation time: each fresh agent reorients from scratch, so keep
  READMEs/progress files current. Anchor: _"Include instructions to maintain
  extensive READMEs and progress files that should be updated frequently."_
- Test harness output goes to files, not stdout. Anchor: _"The test harness
  should not print thousands of useless bytes...log all important information to
  a file."_
- Default to fast sampled test runs (deterministic per agent, random across
  agents). Anchor: _"Use a default `--fast` option that runs a 1% or 10% random
  sample"_.
- Agents cannot tell time; bound test loops. Anchor: _"Claude can't tell time
  and...will happily spend hours running tests instead of making progress."_
- Parallelism needs many _distinct_ failing tasks; otherwise agents pile onto one.
  Anchor: _"Having 16 agents running didn't help because each was stuck solving
  the same task."_
- Assign a dedicated agent to coalesce duplicated code. Anchor: _"LLM-written
  code frequently re-implements existing functionality"_.
- Write the harness for the agent, not for yourself. Anchor: _"I was writing
  this test harness for Claude and not for myself."_

### 21. Designing AI-resistant technical evaluations — 2026-01-21

URL: https://www.anthropic.com/engineering/AI-resistant-technical-evaluations

- Prefer depth over breadth and out-of-distribution problems; evals need redesign
  as models improve (three rewrites so far). Anchor: _"Longer-horizon problems
  are harder for AI to solve completely."_
- Include tool-building judgment in what is assessed. Anchor: _"Human experts
  retain an advantage over current models at sufficiently long time horizons."_

### 22. Demystifying evals for AI agents — 2026-01-09

URL: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

- Grade the outcome (end state), not the path. Anchor: _"it's often better to
  grade what the agent produced, not the path it took"_.
- Multiple trials per task; distinguish pass@k from pass^k. Anchor: _"pass^k
  measures the probability that all k trials succeed"_.
- Partial credit. Anchor: _"Build in partial credit."_
- Keep capability evals (low pass rate) and regression evals (~100%) separate.
  Anchor: _"An eval at 100% tracks regressions but provides no signal for
  improvement"_.
- Good tasks are ones two experts would grade identically; 0% usually means a
  broken task. Anchor: _"A 0% pass rate...is most often a signal of a broken task,
  not an incapable agent"_.
- Read transcripts to validate graders. Anchor: _"You won't know if your graders
  are working well unless you read the transcripts"_.
- Start from what you already test manually; watch for saturation. Anchor:
  _"Start with what you already test manually"_.

### 23. Effective harnesses for long-running agents — 2025-11-26

URL: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Initializer agent (environment, `feature_list.json` with every feature marked
failing, `init.sh`, `claude-progress.txt`) + coding agent sessions that each do
one feature, verify end-to-end, commit, update progress.

- Every session starts by reading progress notes and git log. Anchor: _"Start the
  session by reading the progress notes file and git commit logs."_
- One feature per session; the agent otherwise tries to one-shot everything.
  Anchor: _"The agent tended to try to do too much at once—essentially to attempt
  to one-shot the app."_
- Structured feature list with everything initially failing counters premature
  "done". Anchor: _"Compaction isn't sufficient"_.
- Mandatory end-to-end verification (browser automation) before marking passing.
  Anchor: _"Claude tended to mark a feature as complete without proper testing."_
- Leave the tree mergeable at session end. Anchor: _"End the session by writing a
  git commit and progress update."_
- Tests are immutable from the agent's side. Anchor: _"It is unacceptable to
  remove or edit tests because this could lead to missing or buggy
  functionality."_

### 24. Introducing advanced tool use (Tool Search, Programmatic Tool Calling, Tool Use Examples) — 2025-11-24

URL: https://www.anthropic.com/engineering/advanced-tool-use

- Load tool definitions on demand once they exceed ~10k tokens (85% token
  reduction, accuracy 49%→74% on Opus 4). Anchor: _"Agents should discover and
  load tools on-demand, keeping only what's relevant for the current task."_
  [claude-mechanic; portable as deferred tool loading]
- Let the model write code that calls tools so intermediate data never enters
  context (37% fewer tokens). Anchor: _"Only the final result enters context"_.
- Examples in tool definitions fix what JSON Schema cannot express (72%→90%).
  Anchor: _"JSON Schema excels at defining structure but can't express usage
  patterns or API conventions."_
- Clear names/descriptions matter more when tools are searched. Anchor: _"Tool
  search matches against names and descriptions, so clear definitions improve
  discovery."_

### 25. Code execution with MCP: building more efficient agents — 2025-11-04

URL: https://www.anthropic.com/engineering/code-execution-with-mcp

- Present tools as a code API on a filesystem; the agent imports what it needs
  (98.7% token reduction in the example). Anchor: _"Agents scale better by
  writing code to call tools instead."_
- Filter and transform in the execution environment. Anchor: _"The agent sees
  five rows instead of 10,000"_.
- Keep intermediate and sensitive data out of the model. Anchor: _"Intermediate
  results stay in the execution environment by default."_
- Weigh against sandboxing cost. Anchor: _"Benefits should be weighed against
  implementation costs and sandboxing requirements."_

### 26. Beyond permission prompts: Claude Code sandboxing — 2025-10-20

URL: https://www.anthropic.com/engineering/claude-code-sandboxing

- Two OS-level boundaries together: filesystem and network (allowlist proxy);
  neither alone suffices. Anchor: _"OS-level features to enable two boundaries"_.
- Sandboxing cut permission prompts 84% — isolation enables autonomy. Anchor:
  _"sandboxing safely reduces permission prompts by 84%"_.
- Approval fatigue is a security problem. Anchor: _"approval fatigue, where users
  might not pay close attention"_.
- Anchor: _"even a successful prompt injection is fully isolated"_.

### 27. Equipping agents for the real world with Agent Skills — 2025-10-16

URL: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
(Spec and examples: https://github.com/anthropics/skills ; https://agentskills.io)

- Progressive disclosure: metadata always loaded, body on demand, bundled files
  on reference. Anchor: _"Progressive disclosure is the core design principle
  that makes Agent Skills flexible and scalable."_
- Bundle deterministic code with instructions. Anchor: _"Code is deterministic,
  so this workflow is consistent and repeatable."_
- Write a skill like an onboarding guide; name/description carry the routing.
  Anchor: _"Pay special attention to the name and description of your skill."_
- Let the agent distil its own successful approach into a skill. Anchor: _"Ask
  Claude to capture its successful approaches into reusable context within a
  skill."_
- Only install skills from trusted sources. Anchor: _"We recommend installing
  skills only from trusted sources."_

### 28. Effective context engineering for AI agents — 2025-09-29

URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- Context is finite and degrades with size ("context rot"); minimise high-signal
  tokens. Anchor: _"Find the smallest possible set of high-signal tokens that
  maximize likelihood of desired outcome."_
- Prompts at the right altitude: clear, direct, not brittle if/else. Anchor:
  _"System prompts should be extremely clear and use simple, direct language."_
- Tools: self-contained, robust, non-overlapping. Anchor: _"If a human engineer
  can't definitively say which tool to use, an AI agent can't do better."_
- Just-in-time retrieval via lightweight identifiers (paths, queries). Anchor:
  _"Agents built with just-in-time approach maintain lightweight identifiers."_
- Three long-horizon techniques: compaction (maximise recall, then prune),
  structured note-taking outside context, sub-agents returning 1–2k-token
  summaries. Anchor: _"Maximize recall to ensure compaction prompt captures every
  relevant piece of information."_
- Anchor: _"Do the simplest thing that works will likely remain best advice for
  building agents."_

### 29. Building agents with the Claude Agent SDK (claude.com/blog) — 2025-09-29

URL: https://claude.com/blog/building-agents-with-the-claude-agent-sdk
(the `anthropic.com/engineering/...` URL 308-redirects here)

- The loop is gather context → act → verify → repeat. Anchor: _"Agents that can
  check and improve their own output are fundamentally more reliable."_
- Give the agent a computer (bash, files) rather than narrow tools. Anchor: _"The
  key design principle behind the Claude Agent SDK is to give your agents a
  computer."_
- Verification sources: rules (lint/tests), visual (screenshots), LLM-as-judge.
  Anchor: _"The best way to improve an agent is to look carefully at its output,
  especially failure cases."_
- Anchor: _"Semantic search is usually faster than agentic search, but less
  accurate."_

### 30. A postmortem of three recent issues — 2025-09-17

URL: https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues

- Continuous production evals sensitive enough to tell working from broken.
  Anchor: _"We maintain an extremely high bar for ensuring infrastructure changes
  don't affect model outputs."_
- Privacy-preserving debugging infrastructure and strong user-feedback loops.
  Anchor: _"Reports of specific changes observed...helped us isolate the issues."_

### 31. Writing effective tools for agents — with agents — 2025-09-11

URL: https://www.anthropic.com/engineering/writing-tools-for-agents

- Prototype → evaluate with realistic multi-call tasks → let the agent rewrite
  descriptions from transcripts. Anchor: _"Even small refinements to tool
  descriptions can yield dramatic improvements."_
- Fewer, consolidated, high-impact tools. Anchor: _"More tools don't always lead
  to better outcomes."_
- Namespace by service/resource. Anchor: _"Make sure each tool you build has a
  clear, distinct purpose."_
- Return meaningful context (names not UUIDs; `response_format`
  concise/detailed). Anchor: _"Merely resolving arbitrary alphanumeric UUIDs to
  semantically meaningful language significantly improves Claude's precision."_
- Token efficiency: pagination, truncation, filtering, actionable errors.
  Anchor: _"Tool truncation and error responses can steer agents towards more
  token-efficient behaviors."_
- Anchor: _"Tools are a new kind of software reflecting a contract between
  deterministic systems and non-deterministic agents."_

### 32. How we built our multi-agent research system — 2025-06-13

URL: https://www.anthropic.com/engineering/multi-agent-research-system

- Delegation needs an objective, output format, tool guidance and boundaries per
  subagent. Anchor: _"each subagent needs objective, output format, guidance, and
  boundaries."_
- Scale effort to query complexity with explicit rules (1 agent/3–10 calls …
  10+ agents). Anchor: _"Agents struggle to judge appropriate effort for
  different tasks."_
- Token budget dominates quality (80% of variance); multi-agent ≈ 15× tokens.
  Anchor: _"Multi-agent systems use about 15× more tokens than chats."_
- Start ~20 real queries, LLM-judge with a rubric, judge end state, keep human
  spot checks. Anchor: _"Three factors explained 95% of the performance variance
  in the BrowseComp evaluation."_
- Resume from checkpoints, full tracing, rainbow deploys. Anchor: _"Minor system
  failures can be catastrophic for agents if errors aren't handled
  effectively."_
- Let the model improve its own prompts/tools (tool-testing agent cut task time
  40%). Anchor: _"The gap between prototype and production is often wider than
  anticipated."_

### 33. Claude Code: Best practices for agentic coding — 2025-04-18 (now the living doc at code.claude.com)

URLs: https://www.anthropic.com/engineering/claude-code-best-practices (308 →)
https://code.claude.com/docs/en/best-practices (living doc, undated)

- Verification is the single most important lever; without a check the human is
  the loop. Anchor: _"Give Claude a check it can run: tests, a build, a
  screenshot to compare."_
- Gate stopping on the check: in-prompt, `/goal` evaluator, Stop hook, or a
  fresh-context verifier. Anchor: _"so the agent doing the work isn't the one
  grading it."_ [`/goal`, hooks: claude-mechanic]
- Demand evidence, not assertions. Anchor: _"Have Claude show evidence rather
  than asserting success"_.
- Explore → plan → implement → commit; skip planning when the diff fits one
  sentence. Anchor: _"If you could describe the diff in one sentence, skip the
  plan."_
- Instruction file hygiene: short, only what the model can't infer, prune when
  rules get ignored. Anchor: _"Would removing this cause Claude to make
  mistakes?"_ and _"Bloated CLAUDE.md files cause Claude to ignore your actual
  instructions!"_
- Hooks for must-always-happen, instructions for advice. Anchor: _"Use hooks for
  actions that must happen every time with zero exceptions."_
- Clear context between unrelated tasks; after two failed corrections restart
  with a better prompt. Anchor: _"A clean session with a better prompt almost
  always outperforms a long session with accumulated corrections."_
- Writer/reviewer in separate contexts; tell the reviewer to flag only
  correctness gaps. Anchor: _"A reviewer prompted to find gaps will usually report
  some, even when the work is sound"_.
- Fan-out: generate a task list, loop headless invocations with pre-approved
  tools, test on 2–3 items first. Anchor: _"Refine your prompt based on what goes
  wrong with the first 2-3 files, then run on the full set."_
- Interview-to-spec, then execute in a fresh session. Anchor: _"Time spent making
  the spec precise pays off more than time spent watching the implementation."_

### 34. The "think" tool — 2025-03-20

URL: https://www.anthropic.com/engineering/claude-think-tool

- A no-op "think" tool gives a mid-trajectory scratchpad after tool results;
  pair with domain examples in the system prompt (54% relative gain on τ-bench
  airline). Anchor: _"pairing it with optimized prompting yielded dramatically
  better results."_
- Anchor: _"The 'think' tool doesn't change external behavior unless Claude
  decides to use it."_ [portable to any tool-calling model]

### 35. Building effective agents — 2024-12-19

URL: https://www.anthropic.com/engineering/building-effective-agents

- Workflows (predefined code paths) before agents (model-directed loops); add
  autonomy only when needed. Anchor: _"The most successful implementations use
  simple, composable patterns rather than complex frameworks."_
- Five workflow patterns: prompt chaining, routing, parallelisation
  (sectioning/voting), orchestrator-workers, evaluator-optimizer.
- Agents need ground truth from the environment each step plus checkpoints and
  stopping conditions. Anchor: _"It's crucial for the agents to gain 'ground
  truth' from the environment at each step."_
- Invest in the agent-computer interface as much as the UI; poka-yoke tools
  (absolute paths, formats close to training data). Anchor: _"We actually spent
  more time optimizing our tools than the overall prompt."_
- Anchor: _"Prioritize transparency by explicitly showing the agent's planning
  steps."_

### 36. Claude Code documentation (code.claude.com) — living docs, undated

Pages read: best-practices, memory (CLAUDE.md / AGENTS.md / rules / auto
memory), hooks-guide, sub-agents, agent-teams, agents (parallel comparison),
workflows (dynamic workflows), goal, worktrees, headless, claude-code-on-the-web,
routines, security, code-review, ultrareview, skills, how-claude-code-works,
common-workflows.

- Instruction files are context, not enforcement. Anchor: _"Claude treats them as
  context, not enforced configuration. To block an action regardless of what
  Claude decides, use a PreToolUse hook"_. Target <200 lines; path-scoped rules
  load only when matching files are touched. [claude-mechanic file formats;
  portable rule]
- Hook taxonomy worth copying: PreToolUse (block/modify), PostToolUse, Stop
  (block the turn until a check passes; capped at 8 consecutive blocks),
  SubagentStop, PreCompact, SessionStart with `compact` matcher to re-inject
  critical context, TaskCompleted (require passing tests before a task closes),
  prompt-based and agent-based hooks for judgment calls. Anchor: _"Hooks are
  user-defined shell commands … certain actions always happen rather than relying
  on the LLM to choose to run them."_ Hooks run before every permission mode:
  _"A hook that returns `permissionDecision: "deny"` blocks the tool even in
  `bypassPermissions` mode"_.
- Subagents: own context, returns only a summary, read-only tool sets for
  reviewers, `isolation: worktree`, resumable by id, output scanned for
  instruction-shaped text. Anchor: _"Use one when a side task would flood your
  main conversation with search results, logs, or file contents"_. Depth cap 3,
  concurrency cap 20 by default.
- Agent teams (experimental): shared task list with file-lock claiming,
  mailboxes; partition files per teammate; 3–5 teammates, 5–6 tasks each;
  inter-agent messages are never user consent. Anchor: _"A teammate can't approve
  a permission prompt or supply consent on your behalf"_.
- Dynamic workflows: orchestration in a script, intermediate results in script
  variables, resumable replay, `agent()` with JSON `schema`, adversarial
  cross-checking, `Date.now()`/`Math.random()` throw for determinism. Anchor:
  _"A workflow moves the plan into code."_
- `/goal`: a separate small-model evaluator re-checks a measurable condition
  after every turn; conditions need one end state, a stated check and
  constraints; stalls stop the loop. Anchor: _"completion is decided by a fresh
  model rather than the one doing the work."_
- Worktrees: one checkout per parallel session/subagent, branch from default
  branch, auto-clean when unchanged, `.worktreeinclude` for gitignored env
  files, isolation checks block edits to the main checkout.
- Headless (`-p`): `--bare` for reproducible CI (skips hooks/skills/MCP/memory
  discovery), `--output-format json|stream-json`, `--json-schema`,
  `--allowedTools "Bash(git commit *)"`, `--permission-mode dontAsk`,
  `--permission-prompts none`, resume by session id; exit codes; `system/init`
  exposes plugin/MCP load errors for CI gating. Anchor: _"`--bare` is the
  recommended mode for scripted and SDK calls"_.
- Routines/scheduled runs: prompt must be self-contained and define success;
  fire payloads arrive wrapped as untrusted data the prompt must opt in to;
  green status ≠ task success. Anchor: _"A green status in the run list means the
  session started and exited without an infrastructure error. It does not mean
  the task in your prompt succeeded."_
- Code Review service: parallel specialised reviewer agents, then a verification
  step filters false positives, dedup, severity ranking, neutral check run
  (never blocks), machine-readable severity counts for your own CI gate,
  `REVIEW.md` for severity calibration, nit caps, skip rules, verification bar
  ("behavior claims need a `file:line` citation"), re-review convergence.
  Ultrareview: _"every reported finding is independently reproduced and
  verified"_.
- Security: fail-closed command matching, network commands not auto-approved,
  WebFetch summarised by a separate model call, `-p` sessions show no trust
  dialog so repo content can run hooks/MCP — use `--bare`. Anchor: _"Avoid piping
  untrusted content directly to Claude"_.
- Skills vs CLAUDE.md vs subagents: _"Create a skill when you keep pasting the
  same instructions, checklist, or multi-step procedure into chat"_;
  `disable-model-invocation: true` for side-effecting workflows.
- Context: _"Claude Code manages context automatically … It clears older tool
  outputs first, then summarizes the conversation if needed."_ Customise with a
  "Compact Instructions" section.

### 37. Claude Agent SDK documentation — living docs, undated

URLs: https://code.claude.com/docs/en/agent-sdk/overview , .../sessions ,
.../hooks , .../permissions , .../subagents (platform.claude.com paths 307 →
code.claude.com). Repos: https://github.com/anthropics/claude-agent-sdk-typescript
("The Claude Code SDK is now the Claude Agent SDK."), claude-agent-sdk-python.
`code.claude.com/docs/en/agent-sdk/context-management` returns 404.

- Sessions are an append-only conversation log on disk; `continue`, `resume`,
  `fork`; `SessionStore` adapter for cross-host resume; or don't rely on
  transcripts at all. Anchor: _"Capture the results you need … as application
  state and pass them into a fresh session's prompt. This is often more robust
  than shipping transcript files around."_
- Permission evaluation order: hooks → deny rules → ask rules → mode → allow
  rules → `canUseTool`; `deny > defer > ask > allow` when hooks disagree;
  auto-approved tools never reach the callback. Anchor: _"For checks that must
  run on every tool call, use a `PreToolUse` hook"_. Pair `allowedTools` with
  `dontAsk` for locked-down headless agents.
- `AgentDefinition` fields: description (routing), prompt, tools, model, effort,
  maxTurns (partial result + resume), memory, isolation, `omitClaudeMd`;
  subagents receive only the spawn prompt plus project instructions, never the
  parent transcript. Anchor: _"include any file paths, error messages, or
  decisions the subagent needs directly in that prompt."_
- Caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`,
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `maxBudgetUsd` (ends with
  `error_max_budget_usd`). Hook callbacks: async for side effects only; timeouts
  per event; `PreToolUse` timeout = tool not run.

### 38. Claude API platform docs — living docs, undated

URLs: prompting best practices
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices ;
prompt caching .../prompt-caching ; context editing .../context-editing ;
compaction .../compaction ; memory tool
https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool ;
structured outputs .../structured-outputs .

Prompting best practices (covers Fable 5.1 … Haiku 4.5), agentic section:

- Multi-window workflows: first window sets up framework (tests, `init.sh`),
  later windows iterate a todo list; prefer a fresh window reading the filesystem
  over compaction; be prescriptive about startup. Anchor: _"Review progress.txt,
  tests.json, and the git logs."_ and _"Claude's latest models are extremely
  effective at discovering state from the local filesystem."_
- Structured state in JSON, progress notes in prose, git as the log. Anchor:
  _"Use git for state tracking"_.
- Tell the model compaction exists so it doesn't wrap up early. Anchor: _"do not
  stop tasks early due to token budget concerns."_
- Reversibility guidance: local reversible actions freely, destructive/shared
  ones ask. Anchor: _"do not use destructive actions as a shortcut."_
- Anti over-engineering block. Anchor: _"The right amount of complexity is the
  minimum needed for the current task."_
- Anti test-gaming block. Anchor: _"Tests are there to verify correctness, not
  to define the solution."_
- Investigate before answering. Anchor: _"Never speculate about code you have
  not opened."_
- Parallel tool calls are steerable to ~100%. Anchor: _"Never use placeholders
  or guess missing parameters in tool calls."_
- Dial back "MUST use tool" language for newer models; overtriggering.
  Anchor: _"Where you might have said 'CRITICAL: You MUST use this tool when...',
  you can use more normal prompting"_.
- Subagent over-use guard. Anchor: _"For simple tasks, sequential operations,
  single-file edits, or tasks where you need to maintain context across steps,
  work directly"_.
- Explicit chaining still useful for inspectable pipelines; commonest chain is
  draft → review against criteria → refine. Anchor: _"The most common chaining
  pattern is self-correction"_.

Prompt caching [claude-mechanic]: cache hits need identical prefix; invalidation
hierarchy tools → system → messages; stable prefix first, dynamic last; 5-min
default / 1-h TTL; up to 4 breakpoints; cache reads 0.1× (0.025× on Fable/Mythos
5.1). Anchor: _"Place the breakpoint on the last block whose prefix is identical
across the requests you want to share a cache."_

Context editing [claude-mechanic]: `clear_tool_uses_20250919` clears oldest tool
results past a trigger, `keep` N, `exclude_tools`, `clear_at_least` to justify
cache invalidation; `clear_thinking_20251015`. Anchor: _"Older tool results (like
file contents or search results) are no longer needed once Claude has processed
them."_

Compaction (API) [claude-mechanic]: on-demand (`compact-2026-09-04`) preferred
over threshold; keeps recent turns verbatim, can run in background, custom
summarization prompt. Anchor: _"response quality degrades as a conversation
grows."_

Memory tool [claude-mechanic; pattern portable]: client-side `/memories` dir;
API auto-injects _"ASSUME INTERRUPTION: Your context window might be reset at any
moment"_; handler must prevent path traversal; documents the "multisession
software development pattern" (initializer session, read memory at start, update
at end, one feature at a time, complete only after end-to-end verification).
Anchor: _"Mark a feature complete only after end-to-end verification confirms it
works, not when the code is written."_

Structured outputs [claude-mechanic; concept portable]: `output_config.format`
for responses vs `strict: true` for tool inputs; no recursive schemas, no
min/max; grammar compiled and cached 24 h; refusals override schema. Anchor:
_"JSON outputs control Claude's response format; strict tool use validates tool
parameters."_

---

## Part 2 — Cross-cutting practices (deduplicated)

Numbering is continuous; tags say what ports.

### A. Context engineering

1. **Treat the context window as the scarce resource; load just-in-time.**
   Keep lightweight identifiers (paths, queries, ids) in context and fetch
   content on demand; defer tool definitions and skills until needed; return
   high-signal tool output only (paginate, truncate, filter, resolve ids to
   names). _(context engineering 2025-09; writing tools 2025-09; advanced tool
   use 2025-11; code execution with MCP 2025-11; Claude Code best practices.)_
   [portable]
2. **Keep standing instructions short, layered and verifiable; move procedures
   to on-demand skills and path-scoped rules.** Target <200 lines; cut any line
   whose removal would not cause mistakes; re-audit per model generation because
   old rules over-constrain new models. _(best-practices, memory docs, large
   codebases 2026-05, Fable 5 guide.)_ [portable; `CLAUDE.md`/`.claude/rules`
   formats are claude-mechanic — llm4ts can emit the same content as
   `AGENTS.md`/`GEMINI.md`/system prompt]
3. **Prefer a fresh context that re-derives state from the filesystem over
   in-place summarisation; when you must compact, use an explicit preservation
   list and maximise recall.** Clear between unrelated tasks; after two failed
   corrections restart with a better prompt; tell the model compaction/handoff
   exists so it does not wrap up early; never show it a token countdown.
   _(prompting best practices; Fable 5 & 5.1 guides; harness design 2026-03;
   best-practices.)_ [portable; API compaction/context-editing are
   claude-mechanic]
4. **Keep the transcript append-only and the prefix stable.** Per-turn
   reminders as turn-scoped system messages, instruction changes as
   mid-conversation messages, trimming by a separate pass — editing earlier
   turns resets caches (and on Fable 5.1 invalidates thinking). Put static
   material first, dynamic last. _(Fable 5.1 guide; prompt caching docs; April
   2026 postmortem.)_ [the cache rule is portable to any provider with prefix
   caching; `cache_control`/binding errors are claude-mechanic]
5. **Isolate noisy work in sub-contexts that return a summary.** Exploration,
   test runs, log analysis and reviews run in subagents with their own window and
   a read-only tool set; the parent receives 1–2k tokens, never the transcript;
   pass everything the child needs in the spawn prompt. _(context engineering;
   multi-agent research 2025-06; sub-agents docs; SDK subagents docs.)_
   [portable]

### B. Tool design

6. **Few, consolidated, namespaced, unambiguous tools — written for the agent,
   evaluated with the agent.** If a human can't say which tool to use, neither
   can the model. Prototype, run realistic multi-call evals, read transcripts,
   let the model rewrite descriptions; add worked examples where schemas can't
   express conventions. _(writing tools 2025-09; building effective agents
   2024-12; advanced tool use 2025-11.)_ [portable]
7. **Poka-yoke the agent-computer interface.** Absolute paths, formats close to
   training data, actionable error messages that teach the next step, strict
   schemas on tool inputs where the downstream consumer is code, harness output
   logged to files not stdout. _(building effective agents; structured outputs
   docs; C compiler 2026-02.)_ [portable; `strict: true` is claude-mechanic]
8. **Give the agent a computer and let it write code to orchestrate tools** so
   intermediate data, loops and filtering stay out of the model; weigh this
   against sandboxing cost. _(Agent SDK blog 2025-09; code execution with MCP;
   harness patterns 2026-04; dynamic workflows.)_ [portable — CLI agents already
   have bash]
9. **Provide a cheap reflection step after tool results** (a no-op "think"
   tool or adaptive/interleaved thinking) and batch independent tool calls;
   never guess parameters. _(think tool 2025-03; prompting best practices;
   Fable 5.1 guide.)_ [think-tool pattern portable; adaptive thinking/effort are
   claude-mechanic — map to Codex/Gemini reasoning-effort knobs]

### C. Verification and evals

10. **Nothing is done without a check the agent can run itself, and the
    verifier must be nearly perfect because autonomy amplifies whatever it
    accepts.** Tests, build exit codes, linters, fixture diffs, screenshots,
    browser automation; "done" means an artifact exists on disk and the check
    passed; demand evidence (command + output) not assertions. _(best-practices;
    C compiler; long-running harnesses 2025-11; code migrations 2026-07;
    Fable 5 guide "audit each claim against a tool result".)_ [portable]
11. **Separate the worker from the judge, and make the judge skeptical,
    calibrated and adversarial.** Fresh-context reviewer/evaluator agents beat
    self-critique; calibrate with few-shot scored examples and hard thresholds;
    agree the definition of done ("sprint contract") before coding; tell
    reviewers to report everything and filter severity in a separate pass, or
    to flag only correctness gaps — chasing every finding causes
    over-engineering; verify findings (reproduce, cite `file:line`) before
    posting. _(harness design 2026-03; Opus 5 guide; Code Review/ultrareview
    docs; best-practices.)_ [portable — this is llm4ts's review/judge seat]
12. **Grade outcomes, not paths; run multiple trials; keep capability and
    regression evals apart; read transcripts.** Partial credit; pass@k vs
    pass^k; 0% usually means a broken task; separate infra failures from model
    failures, give ~3× resource headroom, report confidence intervals and
    distrust <3-point gaps; guard eval integrity against leaked answers.
    _(demystifying evals 2026-01; infra noise 2026-02; eval awareness 2026-03;
    multi-agent research.)_ [portable]
13. **Protect the oracle: tests are immutable from the agent's side and must
    not be gamed or hardcoded against.** Instruct the agent to report incorrect
    tests rather than work around them; keep a reference implementation as the
    oracle where one exists. _(long-running harnesses; prompting best practices;
    scientific computing 2026-03; code migrations.)_ [portable]
14. **Every change to the harness (prompt, cache, compaction, default effort)
    gets per-model evals, ablation, canary and soak; keep a user-feedback
    channel and continuous production evals.** _(April 2026 postmortem;
    Sept 2025 postmortem.)_ [portable]

### D. Long-running and multi-session harnesses

15. **Persist a progress ledger + structured task list + git history, and
    make each session read them first and leave the tree mergeable.** An
    initializer session scaffolds `init.sh`, a feature/test list with every item
    initially failing, and a progress file; subsequent sessions do one feature
    at a time, verify end-to-end, commit, update the ledger, and record failed
    approaches so they are not retried. _(long-running harnesses 2025-11; memory
    tool docs; prompting best practices; scientific computing 2026-03; C
    compiler.)_ [portable — the memory tool is claude-mechanic, the files are
    not]
16. **Externalise the session as a durable, replayable event log, decoupled
    from both the model/harness process and the sandbox.** Crashes resume from
    the log; container death is a tool error; credentials never enter the
    sandbox running model-written code; workflow scripts replay completed
    agents from saved results and forbid non-determinism (`Date.now()`,
    `Math.random()`). _(managed agents 2026-04; dynamic workflows docs; SDK
    sessions docs.)_ [portable]
17. **Bound the loop with stopping conditions the model does not control.**
    Turn/budget caps, subagent depth/concurrency caps, stall detection (no tool
    use for N turns), a separate small-model goal evaluator or deterministic
    Stop gate re-checked every turn with a capped number of consecutive blocks,
    "fast" sampled test modes because agents cannot tell time. _(`/goal` docs;
    hooks guide; SDK subagents caps; C compiler; building effective agents.)_
    [portable; `/goal`, Stop hooks and env caps are claude-mechanic]
18. **Write the autonomy contract into the prompt: nobody is watching, act
    rather than announce, scope = the request/approved plan, pause only for
    destructive or scope-changing decisions, local reversible actions are free,
    minimal change, no unrequested extras, no test-gaming.** Re-run effort
    sweeps and strip "verify your work"/"MUST use tool" scaffolding when a model
    that self-verifies arrives. _(Fable 5/5.1 guides; Opus 5 guide; prompting
    best practices; harness patterns 2026-04.)_ [portable text; per-model tuning
    is provider-specific]

### E. Multi-agent orchestration

19. **Start with workflows (predefined code paths) and add autonomy only when
    needed; move the plan into code when work exceeds what one conversation can
    coordinate.** Prompt chaining, routing, parallel sectioning/voting,
    orchestrator-workers, evaluator-optimizer; a script that holds the loop and
    intermediate results, spawns bounded fan-outs and cross-checks results before
    folding them in. _(building effective agents; dynamic workflows 2026-05;
    agents comparison docs.)_ [portable — this is llm4ts's `implementPlanFlow`
    shape]
20. **Delegate with an objective, output format, tool guidance and boundaries;
    scale agent count to task complexity; parallelise only across distinct
    units; partition files; don't make the lead block on children.** 3–5
    workers with 5–6 tasks each; a lock-based shared task list or mechanical work
    queue where failures become the next item; one agent dedicated to
    de-duplicating code; async result delivery with an explicit wait tool.
    _(multi-agent research; agent teams docs; C compiler; code migrations;
    Fable 5.1 guide.)_ [portable]
21. **Right-size the model and effort per stage; budget tokens as the primary
    quality/cost dial.** Token spend explains most quality variance; multi-agent
    ≈15× tokens; measure the pilot and extrapolate; use smaller/lower-effort
    models for mechanical stages and the strongest for judgment. _(multi-agent
    research; code migrations; Opus 5 & Fable 5.1 guides; code modernization
    2026-09.)_ [portable]
22. **Agents communicate through files and typed results, not shared
    transcripts; inter-agent messages are data, never consent.** Workers return
    JSON against a schema where code consumes it; a child's output is scanned for
    instruction-shaped text; a relayed "approval" never satisfies a permission
    check. _(harness design 2026-03; dynamic workflows; sub-agents/agent-teams
    docs.)_ [portable]

### F. Human oversight and safety

23. **Deterministic boundaries first, behavioural ones second.** Filesystem +
    network sandboxing together; egress allowlists; hooks/policy that run before
    any permission mode and cannot be talked out of; battle-tested isolation
    primitives over custom ones; isolation strength matched to how well the
    operator can evaluate commands. _(containment 2026-05; sandboxing 2025-10;
    hooks guide; SDLC security 2026-07.)_ [portable]
24. **Classify actions by real-world impact with a judge that never sees the
    agent's rationale, allow recovery on denial, escalate after repeated
    denials, and treat all tool output, repo config and fired payloads as
    untrusted input.** Four threat causes (overeager, mistake, injection,
    misalignment); conservative defaults; `-p`/headless runs should not load
    repo-supplied hooks/MCP without `--bare`-style isolation. _(auto mode
    2026-03; routines, security and headless docs; containment.)_ [portable
    design; the Claude classifier is claude-mechanic]
25. **Humans front-load the spec, certificate and promotion policy; review
    loops and error-list patterns, not individual outputs; keep a hard
    production gate; log every automated approval with its signals; shadow-mode
    new reviewers and sample-audit.** _(code migrations; code modernization
    2026-09; SDLC playbook 2026-08; SDLC security 2026-07; Claude Code expertise
    research 2026-06.)_ [portable]

---

## Part 3 — Notes for llm4ts specifically

Observed alignment and gaps against the cross-cutting list (not exhaustive):

- The plan → code → review → judge spine already matches practices 11 and 19;
  the typed `Judgment` service matches 22 (judges return typed labels, not
  prose). Practices 10 and 13 argue for making the "check the agent can run"
  (gates, `nodePreflight`) a first-class, mandatory part of every coder node and
  for marking stories done only on evidence (test output, diff on disk).
- Practice 15 maps onto story context / orientation digest / carried findings
  (ADR 0025): the sources add "record failed approaches" and "one feature per
  session, leave the tree mergeable" as explicit rules.
- Practice 3/4 argue for compaction prompts with an explicit preservation list
  and for never mutating earlier transcript turns in API connectors (keep the
  stable prefix for every provider's prefix cache).
- Practice 17: a stall detector (no tool use for N turns) and a per-run budget
  cap are provider-agnostic and cheap; `/goal`-style evaluation is already close
  to the judge seat.
- Practice 24: for CLI connectors run in headless mode, prefer the connector's
  "bare"/isolated flags so repository-supplied hooks/MCP cannot execute, and
  treat connector stdout as data.
- Practice 12: `llm4ts profile` and the judgment eval tooling could record
  trials per task and separate infra failures from model failures.

---

## Sources (with dates)

Engineering blog (anthropic.com/engineering):

- Building effective agents — 2024-12-19 — https://www.anthropic.com/engineering/building-effective-agents
- The "think" tool — 2025-03-20 — https://www.anthropic.com/engineering/claude-think-tool
- Claude Code: Best practices for agentic coding — 2025-04-18 (308 → code.claude.com/docs/en/best-practices) — https://www.anthropic.com/engineering/claude-code-best-practices
- How we built our multi-agent research system — 2025-06-13 — https://www.anthropic.com/engineering/multi-agent-research-system
- Writing effective tools for agents — with agents — 2025-09-11 — https://www.anthropic.com/engineering/writing-tools-for-agents
- A postmortem of three recent issues — 2025-09-17 — https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues
- Effective context engineering for AI agents — 2025-09-29 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Equipping agents for the real world with Agent Skills — 2025-10-16 — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Beyond permission prompts: making Claude Code more secure and autonomous — 2025-10-20 — https://www.anthropic.com/engineering/claude-code-sandboxing
- Code execution with MCP — 2025-11-04 — https://www.anthropic.com/engineering/code-execution-with-mcp
- Introducing advanced tool use — 2025-11-24 — https://www.anthropic.com/engineering/advanced-tool-use
- Effective harnesses for long-running agents — 2025-11-26 — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Demystifying evals for AI agents — 2026-01-09 — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Designing AI-resistant technical evaluations — 2026-01-21 — https://www.anthropic.com/engineering/AI-resistant-technical-evaluations
- Building a C compiler with a team of parallel Claudes — 2026-02-05 — https://www.anthropic.com/engineering/building-c-compiler
- Quantifying infrastructure noise in agentic coding evals — 2026-02-05 — https://www.anthropic.com/engineering/infrastructure-noise
- Eval awareness in Claude Opus 4.6's BrowseComp performance — 2026-03-06 — https://www.anthropic.com/engineering/eval-awareness-browsecomp
- Harness design for long-running application development — 2026-03-24 — https://www.anthropic.com/engineering/harness-design-long-running-apps
- How we built Claude Code auto mode — 2026-03-25 — https://www.anthropic.com/engineering/claude-code-auto-mode
- Scaling Managed Agents: decoupling the brain from the hands — 2026-04-08 — https://www.anthropic.com/engineering/managed-agents
- An update on recent Claude Code quality reports — 2026-04-23 — https://www.anthropic.com/engineering/april-23-postmortem
- How we contain Claude across products — 2026-05-25 — https://www.anthropic.com/engineering/how-we-contain-claude

Research and news (anthropic.com):

- Long-running Claude for scientific computing — 2026-03-23 — https://www.anthropic.com/research/long-running-Claude
- Introducing Claude Opus 4.8 — 2026-05-28 — https://www.anthropic.com/news/claude-opus-4-8
- Claude Fable 5 and Claude Mythos 5 — 2026-06-09 — https://www.anthropic.com/news/claude-fable-5-mythos-5
- How Claude Code is used in practice — 2026-06-16 — https://www.anthropic.com/research/claude-code-expertise
- Introducing Claude Opus 5 — 2026-07-24 — https://www.anthropic.com/news/claude-opus-5
- Introducing Claude Fable 5.1 and Claude Mythos 5.1 — 2026-09-01 — https://www.anthropic.com/claude-fable-and-mythos-5-1 (found via search; not fetched)

claude.com/blog:

- Building agents with the Claude Agent SDK — 2025-09-29 — https://claude.com/blog/building-agents-with-the-claude-agent-sdk
- Agent Harness Design: 3 patterns — 2026-04-02 — https://claude.com/blog/harnessing-claudes-intelligence
- How Claude Code works in large codebases — 2026-05-14 — https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start
- Introducing dynamic workflows in Claude Code — 2026-05-28 — https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- How Anthropic runs large-scale code migrations with Claude Code — 2026-07-16 — https://claude.com/blog/ai-code-migration
- How Anthropic secures its AI-native SDLC — 2026-07-21 — https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle
- The AI-native SDLC playbook — 2026-08-21 — https://claude.com/blog/the-ai-native-sdlc-playbook
- How to prepare for AI-driven code modernization projects — 2026-09-23 — https://claude.com/blog/how-to-prepare-for-ai-driven-code-modernization-projects

Documentation (living, undated; fetched 2026-10-06):

- code.claude.com/docs/en/: best-practices, memory, hooks-guide, sub-agents,
  agent-teams, agents, workflows, goal, worktrees, headless,
  claude-code-on-the-web, routines, security, code-review, ultrareview, skills,
  how-claude-code-works, common-workflows, agent-sdk/{overview, sessions, hooks,
  permissions, subagents}
- platform.claude.com/docs/en/: build-with-claude/prompt-engineering/
  {claude-prompting-best-practices, prompting-claude-opus-5,
  prompting-claude-fable-5, prompting-claude-fable-5-1},
  build-with-claude/{prompt-caching, context-editing, compaction,
  structured-outputs}, agents-and-tools/tool-use/memory-tool,
  managed-agents/overview

GitHub (anthropics):

- https://github.com/anthropics/skills (skills/, spec/, template/; spec at agentskills.io)
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://github.com/anthropics/claude-code
- https://github.com/anthropics/anthropic-cookbook (patterns/agents, tool_evaluation, claude_agent_sdk, managed_agents, cost_optimization)

## Unknown / not found

- No engineering-blog post dated June–October 2026 exists on the index as of
  2026-10-06; 2026 H2 material lives on claude.com/blog, model launch pages and
  docs.
- `https://code.claude.com/docs/en/agent-sdk/context-management` — 404. Context
  management for the SDK is documented inside how-claude-code-works,
  best-practices and the platform compaction/context-editing pages instead.
- `https://www.anthropic.com/news/claude-fable-5-1` — 404; the launch page is
  `anthropic.com/claude-fable-and-mythos-5-1` (2026-09-01), seen only via search
  results and the Fable 5.1 system card listing; content not fetched.
- The "2026 Agentic Coding Trends Report" PDF
  (resources.anthropic.com) and the Fable 5.1 system card PDF were not read.
- `claude.com/code-with-claude/session/tyo-ext-rewriting-bun-in-rust` and
  `.../tyo-ext-how-we-claude-code` (conference session pages) were not fetched;
  the Bun port facts above come from the 2026-07-16 blog post and the dynamic
  workflows post.
- `anthropic.com/research/long-running-Claude` was read via summary only; exact
  run duration in hours is not stated in what was retrieved.
- The claude-agent-sdk-typescript README did not expose a version tag in the
  fetched content; `github.com/anthropics/claude-quickstarts` was not fetched.
- "Claude's Constitution" was not consulted: nothing in the agent-harness
  sources points to it for harness design, and the safety guidance relevant here
  is covered by the auto-mode, containment and SDLC-security posts.
- No Anthropic source was found that discusses a Rust or Bun port _of Claude
  Code itself_; the only Bun/Rust material is the Bun runtime Zig→Rust port.
- Documentation pages carry no publication date; version gates in the text
  (e.g. "requires Claude Code v2.1.283 or later") are the only recency signal.
