# Refine rounds: follow-up stories on a finished epic

Date: 2026-09-30 · Status: design agreed in conversation, spec for review

## Purpose

`epic-stories` ends with every story merged into `epic/<id>`. Then a person
tries the branch and comes back with feedback: "move the balance card above
the list", "remove the export button", "the transfer form loses the amount
on error". Today that feedback has nowhere to go:

- the planner only writes a plan when none exists, so the follow-up stories
  must be hand-written in the plan format;
- the plan refuses two stories owning one path, and a fix almost always
  touches files a merged story owns;
- a second epic would stack a branch on a branch and land twice.

This spec adds **refine rounds**: a round of follow-up stories, planned from
feedback text, run by the same executor on the same epic branch, before the
epic lands.

Success: after a finished run, one command turns a list of feedback items
into approved follow-up stories, runs them in parallel worktrees behind the
same gates and judge, and leaves one epic branch to land once. Items the
planner cannot place come back as a list, not as guesses.

## Decisions taken

1. **Before landing.** A round runs on `epic/<id>` while the epic has not
   landed. Refining a landed epic is refused with a message; the design
   leaves room for it (see "Left open").
2. **A round starts when everything before it is merged**: every story of
   the plan and of every earlier round. A round with an unmerged story
   blocks the next round and blocks `--land`, as unmerged stories do today.
3. **A round is its own plan inside the epic** (approach A). Each round has
   a folder with its feedback, plan, story states, board and report, and
   runs through the unchanged story executor against the same epic branch.
   The approved plan of the epic is never rewritten.
4. **Ownership needs no new rule.** A round's plan holds only that round's
   stories, so paths are exclusive within the round as they are within a
   plan today. Earlier stories are merged and not in it: their paths are
   free to claim. Feedback items that need the same file go into one
   follow-up story.
5. **Plan what is clear, list the rest.** The planner returns stories plus
   a "not planned" list, each item with the reason or the question it needs
   answered. The round runs with the clear ones; the list is printed, kept
   in the round's folder, and shown to the planner of the next round.
6. **An existing round plan wins**, as an existing plan does today: editing
   `rounds/<n>/plan.md` is the approval and the re-plan path.

## Using it

```sh
# plan and run a round from feedback
llm4ts run epic-stories --repo ~/work/portal -- --refine \
  "Move the balance card above the movements list. Remove the export button.
   The transfer form loses the amount when the IBAN is rejected."

# or plan it, read it, then run it
llm4ts run epic-stories --repo ~/work/portal -- --refine --plan-only "…"
llm4ts run epic-stories --repo ~/work/portal

# land once, when happy
llm4ts run epic-stories --repo ~/work/portal -- --land
```

- With `--refine`, the text is the feedback, not an epic's text. The epic is
  the one `--epic <id>` names, or the one epic not landed yet.
- `--refine` with text starts a new round. It is refused while a story of
  the plan or of an earlier round is unmerged, while the last round is
  planned but not finished, when the epic has landed, and when the epic has
  no plan.
- A plain rerun (no `--refine`) finishes what is open: the plan's stories
  first, as today; with those merged, the open round if there is one.
- `--plan-only`, `--concurrency`, `--fail-fast`, the seats, the gates, the
  roster and the judge apply to a round as they do to the plan.
  `epic-stories-board` gets rounds through the shared program.

## A round on disk

```text
.llm4ts/epics/<epic>/
  plan.md  stories/  report.md  board…        the epic, untouched
  rounds/
    1/
      feedback.md      the text given, verbatim
      plan.md          a story plan: this round's stories only
      not-planned.md   items left out, each with its reason or question
      stories/  report.md  board…             the executor's state for the round
    2/ …
```

- The round's plan is a `StoryPlan` with the epic's own `epicId` (so the
  branch is the same `epic/<epicId>`) and the feedback as its `epic` text.
- Story ids are unique across the epic: the flow prefixes each with `r<n>-`
  (and rewrites `dependsOn` to match), whatever the model returned. Branches
  are `story/<epic-id>/r1-move-balance-card`; worktrees sit beside the
  plan's, under the same root.
- Rounds are numbered from 1, without gaps. The next number is one more than
  the highest folder with a plan.

## Planning a round

The reasoning seat plans with the epic branch checked out (the checkout must
be clean, as for any run), so it reads the code as the person tried it. It is
given:

- the feedback text;
- the target's `CONTRIBUTING.md`, as the story planner is;
- the epic's plan and every earlier round's plan, reduced to each story's
  id, title, owned paths and `provides`, so it knows what was built where;
- the approved brief, when the epic has one;
- the previous round's not-planned list, so an answer in the new feedback
  meets its question.

It returns a `RefineProposal`:

```ts
{
  stories: Array<Story>,          // the follow-up stories
  notPlanned: Array<{ item: string; reason: string }>
}
```

Instructions to the planner, beyond the story planner's:

- one story per feedback item, or per group of items that change the same
  files; its description quotes the items it answers;
- `owned` lists the paths the story will change, including existing files;
  `provides` says what the person will see changed;
- `dependsOn` names stories of this round only; items that need one file
  are answered by one story, since two stories never own the same path;
- tests that cover the changed behaviour are updated in the same story;
- an item that is unclear, contradicts another item, or cannot be tied to a
  file goes to `notPlanned` with the question to answer. It is not guessed.

The proposal is validated by `validateStoryPlan` (unique ids, known
dependencies, no cycle, exclusive ownership), then written. When no story is
returned, no round is created: the run prints the not-planned list and
stops.

## Running a round

The round is handed to `implementStoriesFlow` as any plan is, with:

- `plan`: the round's plan;
- `stateDir`: the round's folder;
- `epicBranch`, `worktreeRoot`, seats, gates, judge, setup: as for the plan.

Nothing in the executor changes. Each follow-up story branches from the epic
branch, which holds every merged story; merges back behind the gates and the
judge; and a rerun skips the merged ones. The perimeter gate holds each
story to the paths it declared.

The judge is the configured story judge, unchanged. Its `provides` dimension
reads the story's `provides`, which for a follow-up is the change the
feedback asked for.

At the end the run prints the round's counts, the path of its report, and
the not-planned items.

## Landing and listing

- `--land` refuses while any story of the plan **or of a round** is
  unmerged, naming them. After landing it removes the rounds' worktrees and
  merged branches with the plan's.
- `--list` shows the rounds of each epic: `finished, not landed · round 1:
3/3 merged · round 2: 1/2 merged, 1 not planned`.
- The coverage ledger's progress for an epic counts round stories with the
  plan's. "Delivered" stays "landed".

## Components

```text
packages/flow/src/RefineRound.ts   pure: RefineProposal and NotPlanned schemas, round numbering,
                                   id prefixing, the preconditions, not-planned rendering,
                                   the reduced view of earlier plans for the prompt
packages/flow/src/Landing.ts       LandOptions.rounds: the rounds' plans and state folders,
                                   checked and cleaned up with the plan's
packages/flow/src/FlowError.ts     RefineRefused { epicId, reason }
flows/lib/epic-stories.ts          --refine; loading rounds; the refine planner prompt;
                                   choosing what a run does (plan stories, open round, new
                                   round, land); EpicSummary.rounds and --list
docs/adr/0021-refine-rounds.md     the decision: rounds as separate plans on one epic branch
```

`RefineRound.ts` depends on `StoryPlan.ts` only and does no I/O. Reading
round folders stays in `flows/lib`, beside `listEpics`.

What a run does is one pure decision, tested on values:

| Plan stories | Rounds                | Flags          | The run                          |
| ------------ | --------------------- | -------------- | -------------------------------- |
| unmerged     | none                  | none           | runs the plan, as today          |
| unmerged     | any                   | `--refine "…"` | refused: stories unmerged        |
| all merged   | last one unfinished   | none           | runs that round                  |
| all merged   | last one unfinished   | `--refine "…"` | refused: round n is open         |
| all merged   | none, or all finished | `--refine "…"` | plans round n+1, then runs it    |
| all merged   | none, or all finished | none           | reports, as today                |
| any          | any                   | `--land`       | lands, or refuses naming stories |
| landed       | any                   | `--refine "…"` | refused: the epic has landed     |

`--refine` without text and without an open round is a usage error. So is
`--refine` with feedback beside `--land`: the feedback would be dropped.

## Error handling

- Every refusal is `RefineRefused` with the epic id and a reason that says
  what to do next (rerun to finish round 1; land first is not needed; …).
- A round plan that fails validation is not written; the violations are
  reported as for a story plan, and the feedback is not lost: it is in the
  message, and nothing else was created.
- A round folder without a readable plan is reported by `--list` and
  refused by `--refine` and `--land`, naming the file. It is never skipped
  silently.
- Feedback text goes to the reasoning seat and to `feedback.md` only. It is
  not put in process arguments of a child process, and not in error
  messages beyond the item titles the planner returned.

## Testing

Deterministic, offline, with the in-src fakes and a scripted reasoning seat:

- `RefineRound`: round numbering; id prefixing and `dependsOn` rewriting,
  idempotent on ids already prefixed; every row of the decision table;
  not-planned rendering; the reduced view of earlier plans.
- Planning: the prompt carries the feedback, the earlier stories' owned
  paths and the previous not-planned list; a story claiming a path a merged
  story owns is accepted; two round stories on one path without a
  dependency are rejected; an empty proposal creates no round.
- Running: a round's stories branch from the epic branch and merge into it;
  the epic's own plan, states and report are byte-identical afterwards; a
  rerun resumes the open round; a failed round story blocks the next
  `--refine`.
- Landing: refused with an unmerged round story; round worktrees and
  branches are removed after landing.
- `--list` and the ledger's progress count the rounds.
- Argument parsing: `--refine` with text, with `--plan-only`, with `--epic`,
  without text.

## Left open

- **A landed epic.** A round on a landed epic would base its branch on the
  target and land again; `landed.json` would need to record each landing.
  Refused for now.
- **The brief.** Feedback that removes something the epic's brief has in
  scope does not edit the brief, so the coverage ledger still counts it.
- **Looking at the page.** Gates and judge read code and run scripts;
  nothing checks "move it" visually.
- **A judge tuned for small fixes.** The rubric was written for stories
  that add a feature. Whether it is too strict on a three-line fix is a
  question for the first live round.
- **Feedback from a file or from GitHub issues.**
