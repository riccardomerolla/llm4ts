# Workshop runbook: live J2EE → Next.js conversion demo

Produce the runbook and supporting glue for the client workshop: a
half/full-day session where the whole pipeline runs LIVE — survey, extract,
and all three hero-page conversions — with discussion between phases.
This spec is last in the dependency chain; it consumes everything the other
demo-bank specs build.

Driver: fully-live was an explicit choice (2026-08-30). The mitigation is
not pre-recorded fallbacks but rehearsal + resume: every phase is
checkpointed (plan files, extract per-page resume, judge/review caches,
conversion reports), so a crashed or rate-limited run is restarted and
resumes mid-work — and that recovery is itself a selling point to show.

## Decisions (agreed 2026-08-30)

| Decision  | Choice                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Format    | Half/full-day workshop, all phases live, discussion between phases.                                                                                                                                                                                                                                                                                                                                                      |
| Narrative | Act 1 breadth: seed repos → survey+extract over ~20 pages → board fills with the full planned estate → walk Page Specs. Act 2 depth: convert account overview (fast win) → beneficiaries (CRUD) → wire transfer (finale: session-state → SPA stepper). Act 3 money: migration report, estimated costs (say "estimated" out loud), wave projection to the client's real estate size, B4F story via the OpenAPI contracts. |
| Runtime   | CLI connectors on subscription; costs shown are estimates by design.                                                                                                                                                                                                                                                                                                                                                     |
| Offline   | No network dependencies beyond the LLM CLI itself: local repos, local board, no PRs, warm package caches.                                                                                                                                                                                                                                                                                                                |

## Tasks

- [ ] `RUNBOOK.md` (docs/ or examples/demo-bank/): minute-by-minute
      script per act, exact commands, expected durations measured from
      rehearsal (not guessed), what to say while each phase runs, and the
      recovery drill per failure mode (rate limit, red test loop, judge
      reject loop, machine sleep) — each drill rehearsed, not theoretical.
- [ ] One-command environment prep: seed both fixture repos fresh, warm
      caches, verify toolchain green, verify LLM CLI auth — a `doctor`-like
      preflight that fails loudly before the audience arrives.
- [ ] Demo reset command: tear down work dirs/branches/board state so
      rehearsals and the real run start identical.
- [ ] Timing budget per phase enforced by convert-page options (bounded
      judge rounds, bounded review rounds) so no phase can run away past
      its slot; document the chosen bounds.
- [ ] Show-artifacts checklist: which files to open on screen at each beat
      (PageSpec markdown, board, a diff, the conversion report, the
      OpenAPI contract, the migration report).
- [ ] Full dress rehearsal executed at least twice end-to-end; recorded
      durations written back into the runbook. (Checklist item is the
      evidence note in the runbook, not code.)

## Non-goals

Slides/marketing collateral, pre-recorded video fallbacks (resume IS the
fallback), client-specific customization, and any feature work — if a
rehearsal exposes gaps, they become new specs, not runbook hacks.
