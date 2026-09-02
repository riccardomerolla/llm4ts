# DemoBank workshop runbook

Half/full-day live workshop: the whole J2EE → Next.js conversion pipeline runs
in front of the client, with discussion between phases. There are no recorded
fallbacks by design — every phase is checkpointed (plan files, per-page
extraction resume, judge/review caches, the conversion board), so the recovery
move for ANY failure is: rerun the same command and watch it resume. That
recovery is itself a selling point; demonstrate it deliberately if a failure
hands you the chance.

Say out loud, at least once per act: **all token and cost figures are
estimates** (character-count heuristics — the CLI seats report no usage).

## Act 0 — before the audience arrives

```bash
node examples/demo-bank/preflight.mjs
```

Preflight seeds both fixtures into a temp dir, runs their smoke checks, and
verifies git, pnpm, and the `claude` CLI are present. Fix anything red before
continuing. Then materialize the demo estate (pick a short path you can type
on stage):

```bash
node examples/demo-bank/reset-demo.mjs ~/demo
```

This creates `~/demo/legacy-j2ee` and `~/demo/nextjs` as fresh git repos and
warms the target's node_modules from the pnpm store (documented offline
strategy: the lockfile is committed; run it once on hotel wifi, never on
stage). Finally: `cd ~/demo/nextjs && pnpm test` must be green.

Timing bounds for the day (set in the environment you run flows from):

```bash
export LLM4TS_PACK=packs/j2ee-nextjs-spa
export LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee
export LLM4TS_JUDGE_ROUNDS=1        # bound judge feedback to one round on stage
export LLM4TS_MAX_CLOSURE_FILES=8   # bound legacy evidence per page
export LLM4TS_EXTRACT_CONCURRENCY=3 # pages extracted and judged at once (measure in rehearsal)
```

`LLM4TS_PACK` is the one that matters for Act 1: it is what makes the survey
reason in J2EE terms (web.xml mappings, includes, forwards, ajax targets)
instead of the default COBOL pack's. Discovery needs nothing extra for the
fixture or for a typical client estate — only files the pack's `sources:`
regex matches count, and `.git`, `node_modules`, `target`, `build`, `dist`
are never entered. Keep these two in your back pocket for a real estate with
an unusual layout, never set them on stage without a reason:

```bash
export LLM4TS_EXCLUDE_DIRS=.git,node_modules,target,generated   # replaces the pruned list
export LLM4TS_MAX_DISCOVER_RESULTS=50000                         # default 20000 for estates
```

## Act 1 — breadth: survey and extract (~duration: measure in rehearsal)

```bash
llm4ts run modernize-survey --repo ~/demo/legacy-j2ee
```

Talk track while it runs: 18 pages inventoried, dead pages and fragments
triaged out, waves proposed. Three beats, in the order the artifacts land:

1. `docs/modernization/inventory.md` — the deterministic graph, no model
   involved yet. Point at the `In` column: `header` and `footer` carry one
   incoming edge per page that includes them, `web` (web.xml) fans out to
   every servlet, and the genuinely dead pages are the ones flagged
   `unreferenced — retire candidate?`. That column is what the model is
   asked to trust.
2. `docs/modernization/graph-refine.md` — the edges the regexes could not
   see (form actions and redirects to url-patterns, ajax targets), each with
   the file and line that establishes it. No evidence, no edge.
3. `docs/modernization/wave-plan.md` — fragments travel with the first page
   that includes them, the ESB wrappers come out `wrap` (the port story for
   Act 2), and the waves are user journeys: read-only screens, then CRUD,
   then the session-backed transfer stepper last.

Say once that the prompts behind beats 2 and 3 are the pack's
(`packs/j2ee-nextjs-spa/prompts/survey-*.md`), not the tool's: a client with
a different stack edits two markdown files, not the pipeline. Review the plan
WITH the audience, flip `- [x] Approved` (the human gate is the point — banks
like this beat).

```bash
LLM4TS_WAVE=wave-1 llm4ts run modernize-extract --repo ~/demo/legacy-j2ee
```

Extraction runs three pages at once (`LLM4TS_EXTRACT_CONCURRENCY=3` from Act
0): the pages of a wave are independent, each lands in its own commit holding
only its four files, and the log interleaves — say so before it starts, then
point at `git log --oneline` filling up out of page order. Two lines to say
aloud: concurrency divides the wall clock, not the cost (the estimates in
Act 3 are identical at 1 or 3), and if a quota death hits mid-batch the pages
already in flight still finish and land — the rerun resumes only what is
missing. If the client's plan rate-limits at 3, drop to 1 and narrate the
same resume. Show one finished spec: the prose, then the `json pagespec`
block, then the judge gate verdicts under `docs/modernization/gate/`.

## Act 2 — depth: convert (order: accountOverview → beneficiaryList → transferStep1)

```bash
llm4ts run convert-all --repo ~/demo/nextjs
```

Beats to show while pages convert:

1. `.llm4ts/convert/board.md` in the target — the whole estate planned from
   minute one, pages moving planned → active → done.
2. `contracts/<page>.openapi.yaml` — generated before any model wrote code;
   this file is the future B4F team's requirements document.
3. A finished branch: `git log convert/accountOverview`, the page diff, the
   port/mock pair, the component tests.
4. `docs/conversion/<page>.md` — the per-page report with the estimated
   tokens/cost line.
5. The dev server (`pnpm dev`) showing the converted page next to an original
   JSP screenshot: same form, new house style, mock data flowing through the
   port.

## Act 3 — money and governance

Open `docs/conversion/migration-report.md`: per-page estimates, the remaining
estate, and the projection — then scale the projection aloud to the client's
real page count. Close on governance: branches await human review (no
auto-merge), every page has a spec, a contract, a judge verdict, and a report.

Optional ADO mirror (decide before the workshop, never set it up live):

```bash
export LLM4TS_ADO_ORG_URL=https://dev.azure.com/<org>
export LLM4TS_ADO_PROJECT=<project>
# Auth belongs to the az CLI itself: `az devops login` beforehand (or
# AZURE_DEVOPS_EXT_PAT in the shell) — llm4ts never sees the PAT.
```

## Recovery drills (rehearse each one)

| Failure | Move |
| --- | --- |
| Rate limit / quota death mid-extract | Rerun the same command; per-page resume skips finished specs. Narrate it. |
| Rate limit mid-convert | Rerun `convert-all`; the board skips done pages, the plan file resumes the interrupted one. |
| A page's tests refuse to go green | Let `convert-all` mark it failed and keep walking (default); return to it in discussion. `LLM4TS_FAIL_FAST=1` exists but stays OFF on stage. |
| Machine sleep / network blip | Same as rate limit: rerun. |
| Judge keeps rejecting | `LLM4TS_JUDGE_ROUNDS=1` already bounds it; the failure lands on the board with its reason — governance beat, not a crash. |
| Survey aborts with `discovery stopped at N matching files` (a client's real estate, never the fixture) | The abort names the knobs: tighten the pack's `sources:`/`exclude:`, prune more with `LLM4TS_EXCLUDE_DIRS=.git,node_modules,generated`, or raise `LLM4TS_MAX_DISCOVER_RESULTS`. Rerun. |
| Everything is on fire | `node examples/demo-bank/reset-demo.mjs ~/demo` and restart the act; Act 1 re-runs in minutes. |

## Rehearsal log (fill in — the durations above are placeholders until this is done twice)

| Rehearsal | Date | Act 1 | Act 2/page | Full walk | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |
