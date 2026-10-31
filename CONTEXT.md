# llm4ts

The Effect-TS engine that runs LLM-driven flows (planning, coding, review,
modernization) over connectors to API providers and CLI coding agents.

## Language

### Judgment

**Judgment**:
The act of asking a backend to evaluate typed questions against one State and
return typed answers with probabilities, instead of generated text. Also the
name of the service that performs it.
_Avoid_: Jev, System One, oracle, verdict

**State**:
The content a Judgment evaluates: a string, a JSON object, or an array of
texts. It is data, never instructions.
_Avoid_: context, input, prompt

**Question**:
One atomic, well-scoped thing asked about a State. A request carries many
Questions over one State; each is answered independently of the others.
_Avoid_: rubric, dimension, criterion

**Choice**:
A Question that selects one option from an unordered set. Its answer is the
chosen option key, a probability per option, and a Confidence.
_Avoid_: classification, pick, enum question

**Score**:
A Question that places the State on an ordered scale of described levels. Its
answer is a position (possibly between two levels), a probability per level,
and a Confidence.
_Avoid_: rating, grade, rubric score

**Truth**:
A Question that evaluates a yes/no statement. Its answer is the probability
that the statement holds.
_Avoid_: Noul, boolean question, assertion, predicate

**Confidence**:
A statistic in [0, 1] derived from an answer's probability distribution:
concentrated means confident, spread out means uncertain. It is not a
probability of being correct.
_Avoid_: certainty, accuracy

**Origin**:
Where an answer came from, as four separate facts: the backend and
checkpoint that produced it, the Method that extracted the probabilities,
the Calibration evidence behind them, and whether it replaced an earlier
answer by escalation.
_Avoid_: provenance (that is the modernization manifest), source

**Method**:
How an answer's probabilities were extracted: read from token
log-probabilities, written by the model itself (verbalized), estimated by
repeated sampling, decoded from a reasoning model's typed reply, or returned
by a hosted judgment service.
_Avoid_: provenance, path

**Calibration**:
What is known about whether an answer's probabilities match outcomes: none,
claimed by the provider, or measured by an evaluation in this project.
_Avoid_: accuracy, trust

**Support**:
The share of probability mass a backend actually placed on the offered
options before renormalization. An answer rebuilt from a sliver of mass is
held regardless of its Confidence.
_Avoid_: coverage, mass

### Blackboard

**Blackboard**:
A run-time on which typed Facts are posted and Rules fire when the facts
they match are present, until nothing more fires. The engine decides; a
model only contributes facts through a judge Rule.
_Avoid_: rule engine, workflow, agent memory, chat history

**Fact**:
One named, schema-typed value on a Blackboard, written once per run. Held
in its encoded JSON form; read through its key's schema.
_Avoid_: variable, slot, message

**Rule**:
A condition over Facts and a consequence that posts Facts. Kinds: `derive`
(pure), `judge` (asks the Judgment service and posts the Answer), `rule`
(any effect). It declares what it produces.
_Avoid_: step, task, node, handler

**Ruleset**:
Named imports, exports and Rules, validated when built: every read
produced, one producer per key, every export produced; unreachable Rules
pruned. A value that runs many times.
_Avoid_: pipeline, flow, module

### Epic stories

**Refine round**:
A numbered round of follow-up stories planned from a person's feedback on a
finished, not yet landed epic. Its own story plan and state folder, the
epic's branch. Rounds are sequential.
_Avoid_: iteration, patch, hotfix, follow-up epic

**Not planned**:
A feedback item a Refine round's planner left out, with the reason or the
question whose answer would make it plannable.
_Avoid_: skipped, rejected, open point (that is an epic brief's term)

### Roster and dashboard

**Executor**:
A harness and a model, with the roles it may take and how many Clones of it
may run at once.
_Avoid_: agent, provider, worker

**Clone**:
One of an Executor's concurrent instances. A Lease names the Clone it holds.
The number of Clones is the Executor's slots.
_Avoid_: slot (that is the count), instance, worker, sub-agent

**Lease**:
One Clone taken by a role: for a story's whole life by its coder, for one
call by a reasoning role. Independence is between Executors, never between
Clones of one Executor.
_Avoid_: reservation, booking

**Task**:
One step of a story's plan, written by the story's coder and tied to an
acceptance criterion. A Task may depend on earlier Tasks and own the paths
it changes.
_Avoid_: step, subtask, ticket, todo

**Sub-agent**:
An agent a harness spawned on its own inside a Lease. llm4ts observes it
and attributes its cost to the Lease; it never leases or counts it.
_Avoid_: clone, child executor, worker

**Lane**:
A running story as the dashboard shows it: its Clone, its current Task, its
open stage, and the Sub-agents and parallel Task coders under it.
_Avoid_: box, card, thread

**Board**:
The epic's stories by column (planned, active, waiting, done, failed,
skipped), or one story's Tasks by column (todo, doing, review, done).
_Avoid_: kanban, dashboard (that is the whole screen), tree

### Roundtable

**Roundtable**:
A meeting run by code: chosen Personas speak in turns about a Topic toward
a Goal, item by item, until each item is settled or capped; then the Scribe
writes the outline and the plan. The meeting file and the turn record are
its state.
_Avoid_: pipeline, workflow, council, debate, chat

**Persona**:
A card that says what a speaker is: a name, an order, a mandate, what it
cares about, what it pushes back on, what it never decides alone, and a
voice. Distinct from a role, which is a seat an Executor takes.
_Avoid_: agent, role, seat, reviewer

**Attendee**:
A Persona chosen for one Roundtable. The Scribe and the Owner are never
Attendees.
_Avoid_: participant, member, agent

**Scribe**:
The Persona that writes a Roundtable's deliverables from the whole
transcript and revises them after the review turn. Always present, never
speaks in the discussion.
_Avoid_: secretary, writer, finalizer, architect

**Owner**:
The person who called the Roundtable. Present only through the meeting
file: answers to parked questions and feedback become Owner turns on the
next run.
_Avoid_: user, human, operator, chair

**Chair**:
The code that runs a Roundtable: turn order, rounds, what settles an item,
caps, and the judgment that breaks a stalemate, recorded as Chair turns.
_Avoid_: moderator, facilitator, orchestrator

**Agenda item**:
One question a Roundtable settles, with a title. Proposed by the first
Attendee, edited by the Owner, followed by a fixed closing item (does the
solution reach the Goal?) and, after drafting, a review item.
_Avoid_: topic (that is the whole meeting's subject), story, task

**Turn**:
One Attendee's contribution on one Agenda item in one round: a kind
(position, question, objection, agreement, proposal, pass), the turns it
answers, whether an objection blocks, whether a question needs the Owner,
and the prose body.
_Avoid_: message, comment, post, utterance

**Settled**:
An Agenda item after a complete round with no open blocking objection and
no unanswered question that is not parked for the Owner. A proposal in a
settled item with no open blocking objection is a decision; non-blocking
objections against it are its dissent.
_Avoid_: closed, approved, resolved (that is one objection's state)

**Capped**:
An Agenda item that reached its round cap without settling. Left open and
written to the open questions, never forced.
_Avoid_: failed, timed out, skipped

### Taskforce

**Taskforce**:
A delegation loop run by code: a Chief of Staff writes a Plan of Briefs
toward a Goal, Specialists work their Briefs in Waves, a Reviewer
interrogates the result, the Doc Writer delivers. The plan file and the
reports are its state.
_Avoid_: crew, team, swarm, pipeline, orchestration

**Specialist**:
A Persona chosen for one Taskforce, with hands: a tool grade (none,
read-only, commands, workspace) and a Seat (a roster role). The Chief of
Staff and the Doc Writer are always present.
_Avoid_: agent, worker, attendee, bot

**Chief of Staff**:
The Persona whose only output is the Plan: the Deliverables and the Briefs.
Speaks again only for a Goal check. Never writes prose for the reader.
_Avoid_: coordinator, orchestrator, manager, chair

**Brief**:
One unit of delegated work in a Plan: an owner, what it depends on, its
Wave, and the eight fields GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY,
TIMEBOX, FORBIDDEN, REPORT. Its result is a Report.
_Avoid_: task, story, ticket, assignment

**Report**:
What a Specialist hands back for a Brief: PASS, ISSUES or BLOCKED, the
evidence paths, a one-line summary, questions for the Owner, and the body.
_Avoid_: result, output, response

**Wave**:
The Briefs that run before the next Goal check: the first wave is the Plan,
the second the Chief of Staff's re-plan, the fix wave the Reviewer's act-on
findings. Capped.
_Avoid_: round (that is a Roundtable's), phase, sprint, iteration

**Goal check**:
The Chief of Staff's turn after a Wave: reached, or a second Wave of
Briefs, once.
_Avoid_: retrospective, review, checkpoint

**Finding**:
What a review lens raised against the Deliverables or an Engineer's diff,
in one of four buckets: act-on (a fix Brief), consider, noted, dismissed.
_Avoid_: issue, comment, bug, objection

**Trail**:
`decisions.tsv`: one row per decision code took in a Taskforce, append-only.
_Avoid_: log, audit, history, journal

**Memory note**:
A markdown note under `.llm4ts/memory/`: a topic note the Owner keeps, or a
run note the Memory Manager writes. Recalled by keyword overlap with the
Goal.
_Avoid_: context, knowledge base, embedding, cache

### Findings and verdicts

**Grounds**:
How a finding knows what it claims: `observed` (a measurement, such as a
gate exit or an oracle check), `derived` (computed by code from an
artifact, such as a transcript or a diff line that exists), or `inferred`
(a model's reading). Assigned or downgraded by code, never upgraded on a
model's say-so.
_Avoid_: confidence (that is a Judgment statistic), authority, trust

**Via**:
The channel a finding arrived through: gate, oracle, diff, transcript,
model or human.
_Avoid_: source, origin (that is a gate failure's triage against the base)

**Verdict status**:
What a program or rule verdict is worth: `pass`, `fail`, `truncated` (the
judged context was capped), `unsupported` (a required captured vector was
missing) or `unknown` (nothing ran). Only `pass` aggregates to pass.
_Avoid_: green, red, skipped

**Unknown**:
A question a run could not settle, recorded once per epic with a stable
id and a status (`open`, `blocked`, `contradicted`, `resolved`), and
resolved only by citing a run artifact. Raised by a blocked story, a
deferred finding, a low-confidence trailer or a judge warning.
_Avoid_: open point (that is a refine overlay's term), issue, ticket, todo

### Existing evaluation terms (kept distinct from Judgment)

**Judge**:
An LLM-as-judge evaluator that scores a sample against rubric dimensions
(`eval/Judge`), or the program-level spec-compliance gate (`ProgramJudge`).
Not a Judgment: it generates scored findings rather than answering typed
Questions.
_Avoid_: verifier, grader

**Reviewer**:
A review lens that produces structured findings from a diff.

**Gate**:
A step that turns a check (shell command, coverage rule, judge, lint) into a
review result and can abort the flow when it is not clean.
