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
