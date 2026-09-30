# Epic design: from a legacy extract pack to an approved epic brief

Date: 2026-09-30 · Status: design agreed in conversation, spec for review

## Purpose

The main real-world scenario for llm4ts is reverse-engineering a legacy bank
application. `modernize-extract` does that well: a judged, source-grounded
spec pack per legacy program. The rest of the modernization pipeline (seed,
implement, verify) assumes a program-by-program conversion, and that is too
big and the wrong shape for most engagements: some legacy code is dead, some
features are already bundled in the target stack, and what gets built is a
slice the customer asks for, not the estate.

What works in practice is to distil the analysis into a markdown epic and
hand it to `epic-stories` on the target repository. Today that distilling is
done by hand. This spec adds the flow that does it with the user:
`epic-design`. Given the user's description of an epic, the legacy
repository with its extract pack, and the target repository (or a pack when
the target is new), it proposes an **epic brief**, raises the open points it
could not settle, revises on the user's answers and feedback, and, once the
brief is approved, that file is the input `epic-stories` plans from.

Success: an analyst gets from "we need the current account in the new
portal" to an approved brief whose every statement cites the legacy
behaviour it carries, drops or replaces, without reading the whole pack and
without anything falling out silently.

## Decisions taken

1. **The artifact is an epic brief**, prose in fixed sections. `epic-stories`
   keeps owning the story split; its `plan.md` stays a second approval.
2. **File-first.** The brief is the state. The flow writes it, the user
   edits it (answers, feedback, direct edits), rerunning is the loop, and a
   `Status: approved` line is the approval. A chat front end over the same
   file (`llm4ts shell`) is a follow-up, not a second code path.
3. **The legacy input is always `modernize-extract`'s pack**
   (`docs/modernization/` in the legacy repository). The flow refuses to
   start without it and says to run `modernize-extract` first. When
   `modernize-refine` has been run, its `decisions.md` is read and respected.
4. **The flow is rooted at the target repository.** The brief lives in the
   epic's folder there, beside the plan `epic-stories` will write.
5. **A reasoning agent proposes; deterministic checks decide what is
   acceptable.** The model returns a typed proposal; every citation and
   pointer in it is verified before the brief is written.
6. **Every scenario of every cited program gets a disposition.** In scope,
   dropped, provided by the target, or deferred. Nothing is omitted silently.

## Invocation

```sh
LLM4TS_LEGACY_REPO=~/legacy/ib-core \
  llm4ts run epic-design --repo ~/work/portal "Current account: balance, movements, statements"

llm4ts run epic-design --repo ~/work/portal -- --epic conto-corrente   # revise or validate
```

- `LLM4TS_LEGACY_REPO` (required): the legacy repository holding
  `docs/modernization/`.
- `LLM4TS_PACK` (optional): the pack describing the target stack, resolved as
  for `modernize-extract`. Needed when the target repository is new or
  nearly empty; otherwise the repository itself is the evidence of what the
  target provides.
- Seats: the reasoning seat (`LLM4TS_REASONER`), read-only, as in
  `epic-stories`. No coder.
- State: `<target>/.llm4ts/epics/<epic-id>/brief.md`. The id is derived from
  the text with `epicIdFor`, the function `epic-stories` uses, so the brief
  and the plan share a folder. `--epic <id>` works on an existing one;
  `--list` shows the repository's epics with their brief status.

## The brief

Markdown with a fixed structure the flow parses and re-renders, and prose
inside it. `EpicBrief` is a schema; `parseEpicBrief` and `renderEpicBrief`
round-trip it, following `Decisions.ts`.

```markdown
# Epic brief: conto-corrente

Status: draft
Request: Current account: balance, movements, statements
Legacy: ~/legacy/ib-core @ 4f2c1ab · Pack: j2ee-nextjs/nextjs-spa

## Goal

What the epic delivers, in the target's terms.

## Legacy programs considered

- CONTO_SALDO — balance inquiry
- CONTO_MOVIMENTI — movements list and filters

## In scope

- Movements list with date and amount filters
  - CONTO_MOVIMENTI › Filter movements by date range
  - CONTO_MOVIMENTI › Filter movements by amount

## Dropped

- CONTO_MOVIMENTI › Export movements to fax — dead: no caller since 2019

## Provided by the target

- CONTO_SALDO › Session timeout warning — src/kit/session/SessionGuard.tsx

## Deferred

- CONTO_MOVIMENTI › Download statement as PDF — next epic (document service not ready)

## Constraints

House rules, contracts and data the stories must respect.

## Open points

1. Are pending movements shown with the booked ones, or in a separate list?
   Answer:

## Feedback

Change requests for the next revision.
```

Rules of the format:

- A **citation** is `PROGRAM › scenario title`, both exactly as in the pack
  (`specs/<PROGRAM>.md`, `features/<program>.feature`). An in-scope item
  carries one or more citations; an item with none is allowed only when it is
  new behaviour with no legacy counterpart, and then it must say so
  (`new: <reason>`).
- A **dropped** entry carries a reason. A **provided** entry carries a
  pointer: a path in the target repository or `pack:<pattern-or-scaffold>`.
  A **deferred** entry carries a note.
- An **open point** is a numbered question with an `Answer:` line. Answered
  means a non-empty answer.
- `Status` is `draft` or `approved`. Only the user writes `approved`.

## The loop

One run does exactly one of these, decided from the file:

| State of `brief.md`                                      | The run                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| absent                                                   | **Propose**: select programs, propose, check, write the brief as `draft`.                         |
| `draft`, with answered open points or non-empty feedback | **Revise**: the agent revises from the current file; answered points are folded in and removed.   |
| `draft`, unanswered open points, no feedback             | **Halt** with `OpenPointsPending` (the existing typed error), naming the brief and the questions. |
| `draft`, no open points, no feedback                     | **No-op**: says the brief awaits approval and how to approve it.                                  |
| `approved`                                               | **Validate**: run the checks; on success print the `epic-stories` command; never rewrites.        |

- The user's direct edits are the current state. A revision receives the
  file as it is and is told to keep everything the feedback does not ask to
  change. The Feedback section is emptied after a revision that used it.
- An `approved` brief with an unanswered open point or a failing check is
  refused with a typed error; the file is not touched.
- Every write is a commit-free file write (`.llm4ts/` is state, as for
  `epic-stories`); the run prints what changed since the previous revision:
  items added, moved between lists, open points raised and closed.

## How a proposal is made

Two typed calls to the reasoning seat, then checks.

1. **Select.** Input: the request and the pack's index, built
   deterministically: each program's name, the first paragraph of its spec
   and its scenario titles, plus refine's dispositions when present. Output
   (schema `ProgramSelection`): the programs relevant to the request, each
   with a one-line reason. On a revision, the brief's "Legacy programs
   considered" list is the selection; feedback can add or remove programs
   and the agent may propose additions as an open point, never silently.
2. **Propose.** Input: the request, the selected programs' specs and
   features (capped by `LLM4TS_CONTEXT_BUDGET`, with `capped`), the target's
   house rules (CONTRIBUTING.md), the pack's target description when given,
   and, on a revision, the current brief. The seat is the read-only agent
   rooted at the target repository, so a `provided` pointer comes from a
   file it opened. Output (schema `EpicBriefProposal`): goal, scope items
   with citations, dropped, provided, deferred, constraints, open points.
   This is the seam `modernize-refine` already uses for its proposals
   (`structuredAndPublish` on the read-only seat).
3. **Check** (next section). A failing check is fed back for one bounded fix
   round; what still fails becomes an open point in the brief, flagged as
   raised by the checks, so the user sees it and the brief is never written
   with a silent defect.

## Checks (`checkEpicBrief`, deterministic)

Run on every proposal before it is written and on every `approved` brief.

| Check             | Failure                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Citation exists   | a cited program or scenario title is not in the pack                                                                        |
| Pointer exists    | a `provided` path is not in the target repository, or a `pack:` pointer is not in the pack                                  |
| Reason present    | a dropped entry without a reason, a deferred entry without a note, an uncited in-scope item without `new:`                  |
| One disposition   | a scenario appears in two lists                                                                                             |
| Complete          | a scenario of a program under "Legacy programs considered" appears in no list                                               |
| Refine respected  | a scenario `decisions.md` marks `drop` or `provided` is in scope here (allowed only with an answered open point saying why) |
| Approval is clean | `Status: approved` with an unanswered open point                                                                            |

The result is a typed list (`BriefProblem` union), all problems at once, in
the manner of `validateDecisions`.

## Hand-off to `epic-stories`

`runEpicStories` (shared by `epic-stories` and `epic-stories-board`) gains
one step when it resolves the epic: if `<epic folder>/brief.md` exists, it
is parsed and checked; `approved` → the rendered brief replaces the
one-sentence text as the planner's input (`generateStoryPlan`), and the
story plan's `epic` field keeps the brief's `Request` line; `draft` → the
run stops with a typed error saying to approve it or run `epic-design`.
Without a brief nothing changes. The legacy repository is not needed at
this point: the brief is self-contained.

## Components

```text
packages/flow/src/EpicBrief.ts     EpicBrief schema, parse/render, BriefProblem, checkEpicBrief,
                                   EpicBriefProposal + ProgramSelection schemas and JSON schemas
flows/lib/epic-design.ts           pack index, prompts, the loop's decision (what this run does),
                                   diff between two revisions, flag parsing
flows/epic-design.ts               the flow entry (header comment, runNode, stages)
flows/lib/epic-stories.ts          brief pick-up in runEpicStories
flows/fixtures/epic-design/        a small extract pack and target for tests
```

`EpicBrief.ts` depends on nothing but Effect and the flow's `Persistence`;
it reads the pack through an interface (`PackIndex`: programs, scenario
titles, refine dispositions) that `flows/lib/epic-design.ts` builds from the
files, so the checks are testable without a repository.

## Error handling

Typed, in `FlowError`: `ExtractPackMissing { legacyRepo }` (no
`docs/modernization/`), `EpicBriefInvalid { path, problems }` (an approved
brief failing checks, or an unparseable file, with line numbers),
`EpicBriefNotApproved { path }` (raised by `epic-stories`), and the existing
`OpenPointsPending`. Messages name files, programs and scenario titles;
never spec or source content.

## Testing

Deterministic, offline, with the in-src fakes (`makeMemoryPlainFileStore`, a
reasoning seat returning canned structured replies):

- `EpicBrief`: parse/render round trip, including a brief the user edited
  by hand; each check, one test per problem kind, and all problems reported
  together.
- The loop: one test per row of the table above; a revision keeps a direct
  edit and empties Feedback; an approved brief is never rewritten.
- A proposal with a bad citation gets one fix round, and what still fails
  lands as a check-raised open point.
- Completeness: a program with five scenarios and a proposal covering four
  fails until the fifth has a disposition.
- Hand-off: `runEpicStories` uses an approved brief as the planner input and
  refuses a draft; with no brief, the existing epic-stories tests stay green
  unchanged.
- The pack index is built from the fixture pack and matches its programs and
  scenario titles.

## Out of scope (first version)

- A ledger of legacy coverage across several epics (which scenarios no epic
  has claimed). The per-brief completeness check is the first half; the
  ledger is the natural follow-up.
- The chat front end (`llm4ts shell` verb over the same file).
- Generating the story plan, or running `modernize-extract`.
- Legacy analyses that are not an extract pack.
