# ADR 0040: Pull-Model Story Context Over MCP

Status: Proposed, gated on a measurement · Date: 2026-10-12 · Extends ADR 0025, ADR 0030, ADR 0029

## Context

A story's coder receives its context by push: the orientation digest, the
readFirst anchors, carried notes and the acceptance criteria are rendered
into the prompt under character budgets (ADR 0025, `Context.ts`), capped at
tens of thousands of characters and truncated visibly when they do not fit.
The code graph (ADR 0030) answers `llm4ts graph query`, `path` and `closure`
from the terminal, but a coder seat cannot call it; it gets whatever the
prompt pasted.

`McpServer.ts` already serves two tools to harnesses that accept an MCP
configuration (`ask_user`, `approve`), over stdio, for Claude Code, Codex, pi
and Gemini CLI. rea's transport measurements
(`docs/research/rea-gap-analysis.md`, section 3.2) say a summary-first,
pull-on-demand contract costs fewer tokens per completed task than a capped
paste; those measurements are rea's, on rea's tools, and have not been
reproduced here.

## Decision

1. **The seam.** `McpServer.ts` gains a tool set over the code graph and the
   orientation digest: `graph_query`, `graph_path`, `graph_closure`,
   `orientation`, each with an input schema and an `outputSchema`, served
   through the same stdio server a harness already receives for `ask_user`.
   API seats, which take no MCP configuration, keep the paste.
2. **The prompt shrinks only where the tool answers.** The orientation
   digest stays in the prompt as a summary; the readFirst closure and the
   graph neighbourhood move behind the tools, and the prompt says which tool
   answers what.
3. **Measured before it is the default.** The change ships behind a roster
   knob, off by default, and becomes the default only when the harness-evals
   pass predicate (`specs/pending/harness-evals-pass-predicate.md`) shows no
   regression on the light fixture and `profile --against` shows fewer
   prompt characters or fewer explore calls per story, on at least two
   harnesses.

## Considered options

- Raise the paste budgets. Rejected: the cap exists because a longer prompt
  is a slower, costlier turn on every harness (ADR 0025).
- A per-harness file on disk the coder is told to read. Rejected: it is the
  same push model with a detour, and only one harness reads context files
  by default.
- Depend on rea as the MCP server. Rejected: rea serves binary analysis, not
  this repository's graph; the idea is distilled, not the code (ADR 0007,
  ADR 0030).

## Consequences

- The MCP server is no longer two tools; its contract (`tools/list` with
  output schemas) becomes a surface harness-evals must cover.
- Divergence from llm4zio v4.2.0, which has no MCP server; recorded in
  `docs/parity.md` as additive.
