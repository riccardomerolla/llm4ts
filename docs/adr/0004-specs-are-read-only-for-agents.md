# ADR 0004: Specs Are Read-Only For Agents

## Status

Accepted.

## Context

The spec queue in `specs/` is the contract between the user and autonomous
agents. During dogfood runs, the loop's coder edited spec files three times:
recording a design decision inside a spec (invited by the spec's own
wording), rewriting a pending task's description, and marking a deferred
task resolved with an explanatory note. Each edit was individually
reasonable and collectively corrosive: a spec that agents can rewrite stops
being a contract, task state drifted from reality (a deferred task was
synced as complete), and decision rationale ended up scattered across spec
prose instead of the decision log.

## Decision

Agents never create or edit files under `specs/`. Concretely:

- Spec checkbox state is written only by deterministic harness code
  (checkbox sync), never by a model.
- Design decisions made while implementing a spec are recorded as ADRs in
  `docs/adr/`, not as prose in the spec.
- When a task cannot be done or requires diverging from its spec, the agent
  says so in its reply (which reaches the run log and trace) and records a
  durable justification as an ADR; the spec itself stays untouched. The
  user reconciles the spec.
- The dogfood harness enforces the rule mechanically: after every coder
  turn it reverts modifications and removes new files under `specs/` before
  inspecting diffs, and its system prompt states the rule.
- Only the user moves specs between `pending/` and `completed/` (this
  restates the existing rule) and only the user or their interactive
  assistant amends spec text.

## Consequences

- Specs remain trustworthy as work orders; false completion states cannot
  be introduced by a coder turn.
- Useful rationale still has a durable home (`docs/adr/`), discoverable by
  future agents through the engineering guide.
- `RALPH_AUTO_PROMPT.md` and `specs/README.md` are aligned with this rule;
  Ralph's progress tracking relies on its `TASK_COMPLETE` signals and
  `progress-auto.txt`, not spec edits.
