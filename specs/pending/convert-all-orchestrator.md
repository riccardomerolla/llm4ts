# Flow: convert-all orchestrator, board port, estimated-cost report

New flow script `flows/convert-all.ts`: walk the survey inventory of the
legacy repo and drive `convert-page` per page in wave order, maintaining a
progress board and a migration-level cost report. This is the breadth half
of the PoC demo (planned/ongoing/done across the whole estate) on top of
the depth half (`specs/pending/convert-page-flow.md`).

Driver: "enterprise grade" means the client can always answer: what is
planned, what is running, what is done, what did it cost, what will the
rest cost. The board and the report are those answers as artifacts.

## Decisions (agreed 2026-08-30)

| Decision   | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordering   | From the survey wave plan (complexity-ordered); pages classified dead/fragment are listed but skipped with a reason.                                                                                                                                                                                                                                                                                                                                                     |
| Resume     | Pages with an existing completed conversion report (and intact branch) are skipped; interrupted pages resume via convert-page's own plan checkpoint. The orchestrator holds no state of its own beyond what reports/branches encode.                                                                                                                                                                                                                                     |
| Board      | A `BoardSync` port (flow-level service) with ops shaped like the lifecycle: plan(items), start(page), complete(page, result), fail(page, reason). Default adapter: local board file(s) — JSON (schema-validated, versioned) plus a rendered markdown board — demoable fully offline. Azure DevOps adapter is a separate stretch spec (`specs/pending/ado-board-adapter.md`).                                                                                             |
| Costs      | **Estimates only, clearly labeled.** CLI connectors report no usage (see `packages/core/src/Connector.ts`); the PoC does not patch that (decision 2026-08-30, revisit post-PoC — candidate future spec: parse claude CLI JSON usage). Estimation: character-count heuristics + `PriceList` rates, recorded per page in the conversion report and aggregated into the migration report. Every figure carries an `estimated: true` marker and the reports say so in prose. |
| Projection | Reuse the `Bench`/`BenchReport` wave-projection machinery to extrapolate whole-estate cost/time from the converted pages — the "now imagine ×400 pages" number, labeled as an estimate of an estimate.                                                                                                                                                                                                                                                                   |

## Tasks

- [ ] `BoardSync` port + local-file adapter (JSON schema, versioned
      persistence, markdown render with planned/active/done/failed
      sections, per-page links to spec, branch, conversion report).
- [ ] Inventory consumption: read the survey/triage output, produce the
      ordered work list, publish the full list to the board up front (the
      breadth visual: everything "planned" from minute one).
- [ ] Per-page loop: board transitions around each convert-page run;
      fail-fast vs continue-on-page-failure as an explicit option
      (default: continue, mark failed, keep going — a stuck page must not
      kill the workshop).
- [ ] Estimated-usage recorder: character-based token estimation feeding
      the existing `CostTracker`/`CostLedger` event path where possible,
      with the `estimated` marking preserved end-to-end into
      `costs.jsonl` and reports. No pretend precision: round aggressively.
- [ ] Migration report artifact: pages total/converted/remaining, per-page
      estimated cost, wave projection for the remainder (Bench reuse),
      gate/judge pass rates. Markdown + JSON.
- [ ] Deterministic tests: board lifecycle with the memory store, resume
      logic (skip completed, resume interrupted), continue-on-failure,
      estimation math, report rendering.

## Non-goals

Azure DevOps calls (stretch spec), parallel page conversions (sequential is
fine for the PoC and kinder to subscription rate limits), real token
usage capture, auto-merge, and any scheduling/queueing beyond the ordered
walk.
