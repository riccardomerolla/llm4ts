# Stretch: Azure DevOps adapter for BoardSync

STRETCH GOAL — build only after the specs it depends on are done and the
workshop schedule allows (`specs/pending/convert-all-orchestrator.md`
defines the `BoardSync` port this implements; the local-file adapter is the
default and the demo must never depend on this one).

Driver: the bank prospect uses Azure DevOps; a live board mirroring
planned/active/done work items during the workshop is a strong visual, but
it is explicitly nice-to-have (decision 2026-08-30).

Baseline: `packages/flow/src/AzureDevOpsTool.ts` already has PAT auth,
`readWorkItem`, `wiqlIds`, `setFields`, `setState`,
`setAcceptanceCriteria`, `createPr`. The gap is work-item **creation** and
the adapter mapping.

## Decisions (agreed 2026-08-30)

| Decision    | Choice                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target      | A free dev.azure.com org/project owned by us, prepared before the workshop; PAT via env, never in args/logs/errors (CLAUDE.md secrets rule — note `authorizationHeader` handling in review).            |
| Mapping     | 1 Epic = the migration; 1 Feature = wave; 1 PBI/Task = page. States New → Active → Resolved driven by BoardSync plan/start/complete; failures get a tagged comment/field, not a state invented per run. |
| Fields      | Page id, branch name, estimated cost (labeled estimated), judge verdict summary, link/path to the conversion report.                                                                                    |
| Idempotency | Re-running plan() must find existing items (WIQL by a stable page-id field/tag) and not duplicate them.                                                                                                 |

## Tasks

- [ ] `createWorkItem` on AzureDevOpsTool (JSON-patch POST, typed errors,
      same guarded/capability style as existing ops; deterministic tests
      with the HTTP fake).
- [ ] Any missing ops the mapping needs (e.g. work-item comment/link) —
      keep the op set minimal, mirror the GitHubTool work-queue precedent
      (`specs/pending/github-tool-work-queue.md`) of no speculative ops.
- [ ] `BoardSync` ADO adapter implementing plan/start/complete/fail with
      the idempotent lookup.
- [ ] Setup runbook section: org/project creation, PAT scopes, field/tag
      conventions, dry-run verification command.
- [ ] `docs/parity.md` note (additive extension beyond pinned llm4zio).

## Non-goals

Azure Repos hosting, ADO PRs (branches-only decision stands), ADO
pipelines, area/iteration management beyond the fixed mapping, and any
hard dependency from convert-all onto this adapter.
