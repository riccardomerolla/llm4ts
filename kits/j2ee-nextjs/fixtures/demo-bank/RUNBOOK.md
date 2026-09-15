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
node kits/j2ee-nextjs/fixtures/demo-bank/preflight.mjs
```

Preflight seeds both fixtures into a temp dir, runs their smoke checks, and
verifies git, pnpm, the `claude` CLI, and that the installed `llm4ts` ships
the `j2ee-nextjs` kit with its `j2ee-nextjs-spa` pack (`@llm4ts/shell`
0.18.0 or newer). Fix anything red before continuing. Then materialize the
demo estate (pick a short path you can type on stage):

```bash
node kits/j2ee-nextjs/fixtures/demo-bank/reset-demo.mjs ~/demo
```

This creates `~/demo/legacy-j2ee` and `~/demo/nextjs` as fresh git repos and
warms the target's node_modules from the pnpm store (documented offline
strategy: the lockfile is committed; run it once on hotel wifi, never on
stage). Finally: `cd ~/demo/nextjs && pnpm test` must be green.

Timing bounds for the day (set in the environment you run flows from):

```bash
export LLM4TS_PACK=j2ee-nextjs-spa
export LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee
export LLM4TS_JUDGE_ROUNDS=1        # bound judge feedback to one round on stage
export LLM4TS_MAX_CLOSURE_FILES=8   # bound legacy evidence per page
export LLM4TS_EXTRACT_CONCURRENCY=3 # pages extracted and judged at once (measure in rehearsal)
```

`LLM4TS_PACK` is the one that matters for Act 1: it is what makes the survey
reason in J2EE terms (web.xml mappings, includes, forwards, ajax targets)
instead of the default COBOL pack's. It is a bare pack name, resolved across
the kits `llm4ts kits` lists — the `j2ee-nextjs` kit ships it — and every
`llm4ts run` below accepts the same value as `--pack j2ee-nextjs-spa` if you
would rather have it visible in the command on stage. Prove the whole
selection before anyone is watching, with no model call and no cost:

```bash
llm4ts kits
llm4ts run modernize-pack-check --pack j2ee-nextjs-spa --repo ~/demo/legacy-j2ee
```

The check must end `check passed with 1 warning`: 34 source files, 18 JSP
programs, the servlet, form, ajax, include, and servlet-class rules each
capturing real units, and the one expected warning — the pack ships no
`vectors` prompt because it runs no replay phase. If it says `not found: no kit ships it`, the installed shell is
older than 0.18.0. Discovery needs nothing extra for the fixture or for a
typical client estate — only files the pack's `sources:` regex matches
count, and `.git`, `node_modules`, `target`, `build`, `dist` are never
entered. Keep these two in your back pocket for a real estate with an
unusual layout, never set them on stage without a reason:

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
(`kits/j2ee-nextjs/packs/j2ee-nextjs-spa/prompts/survey-*.md`), not the
tool's, and that the pack travels in a **kit** with its scaffold and
review lenses: a client with a different stack copies the kit into
`.llm4ts/kits/<client>/`, edits markdown, and runs `modernize-pack-check`
until it passes — the pipeline is untouched. Review the plan WITH the
audience, flip `- [x] Approved` (the human gate is the point — banks like
this beat).

```bash
LLM4TS_WAVE=wave-1 llm4ts run modernize-extract --repo ~/demo/legacy-j2ee
```

Act 2 opens with `accountOverview`, and the survey's plan puts that page in
**wave-2** (wave-1 is the navigation shell: login, header, footer, nav,
dashboard, profile, settings, messages, help), so extract wave-2 as well
before Act 2 — it is one page plus its servlet and DTO, minutes not tens of
minutes. Each wave gates only its own units; the pages of later waves are
listed as "not gating" — say so when the line scrolls past, and mention the
closing run without `LLM4TS_WAVE` that enforces coverage over the whole
estate once every wave is in.

```bash
LLM4TS_WAVE=wave-2 llm4ts run modernize-extract --repo ~/demo/legacy-j2ee
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
The kit is the deliverable the client keeps: their packs, scaffold, lenses,
and the lessons the review phase appends, in one directory they own.

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
| `⟳ flaky … (fresh retry)` lines scrolling past — Gemini CLI's `Loop detected` / `A potential loop was detected`, an empty response, a malformed tool call | Nothing to do: the seat restarts the turn in a fresh process, up to 6 times, and the flow carries on. Say it out loud: the turn was lost, the quota and the prompt were not. Only if all 6 fail does the stage abort — rerun, it resumes. |
| `⟳ structured output (repair retry)` lines — `Failed to parse response as structured output` | Nothing to do: the model gets its own parse failure quoted back and is asked for the JSON alone, up to 2 more times. If the third reply still does not parse the stage aborts with the reason — rerun resumes; a schema the model can never satisfy is a pack bug, not a stage bug. |
| `pack 'j2ee-nextjs-spa' not found: no kit ships it` | The shell predates kits (0.18.0) or `LLM4TS_PACK` was overwritten with a path: `llm4ts kits` shows what it sees; `npm i -g @llm4ts/shell@latest`; re-export the bare name. Never happens after a green Act 0. |
| Survey aborts with `discovery stopped at N matching files` (a client's real estate, never the fixture) | The abort names the knobs: tighten the pack's `sources:`/`exclude:`, prune more with `LLM4TS_EXCLUDE_DIRS=.git,node_modules,generated`, or raise `LLM4TS_MAX_DISCOVER_RESULTS`. Rerun. |
| Everything is on fire | `node kits/j2ee-nextjs/fixtures/demo-bank/reset-demo.mjs ~/demo` and restart the act; Act 1 re-runs in minutes. |

## Rehearsal log (fill in — the durations above are placeholders until this is done twice)

| Rehearsal | Date | Act 1 | Act 2/page | Full walk | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-14/15 | survey 5m47s ($1.08 est.); extract wave-1 (9 pages, concurrency 3): 11m06s extraction + 1m40s gate + fix rounds ≈ 30–45 min; extract wave-2 (1 page): 2m27s extraction + gate/fix rounds ≈ 16 min | accountOverview 44m29s: acl 12m36s, page 18m33s, tests 12m25s, verify 11s, judge 44s — judge NOT cleared | ≈ 2h30 of flow time, plus reruns | first live walk; 4 findings below, 3 fixed in 0.18.1; the demo estate was a scratch copy, the coder seat `claude` |
| 2 | | | | | |

### Rehearsal 1 findings (2026-09-14/15)

1. **Act 2's first page is not in wave-1.** The survey puts `accountOverview`
   in wave-2 (wave-1 is the navigation shell). Act 1 now extracts wave-2 as
   well (see above). Runbook fixed.
2. **A wave-scoped extraction could never clear its gate.** Coverage ran
   over the whole estate, so wave-1 failed on `/accountOverview` and
   `doTransfer` (wave-2/4 units) and burned three fix rounds — ~17 min per
   attempt — trying to cover them. Fixed in 0.18.1: a wave gates only its
   own units and lists the rest as not gating; one closing run without
   `LLM4TS_WAVE` enforces estate-wide coverage.
3. **A malformed `pagespec` block reached `convert-page`.** The old
   estate-wide fix round had drafted `accountOverview.md` with `apiCalls`
   as prose strings; the judge scored it, and `convert-page` was the first
   to reject it (`invalid page spec block ... at ["apiCalls"][0]`). Fixed in
   0.18.1: J2EE packs declare `spec-schema: pagespec`, the extraction gate
   decodes every block by code before the judge, and the finding states the
   exact shape the analyst must produce (the first fix round without that
   hint failed twice; with it, one round).
4. **The page spec cannot express a list response.** `apiCalls[].response`
   is a flat list of field mappings, so the deterministic OpenAPI contract
   flattened `accts[].curBal` into a single `currentBalance` scalar and the
   coder built a one-balance page; the judge scored spec-compliance 0
   against the spec's per-account table. OPEN: `PageSpec` needs a DTO
   reference with a list/single shape on the response (and `openApiFor`
   an array schema) before Act 2 can pass on `accountOverview`. Until then,
   rehearse Act 2 on a single-object page, or accept the judge failure as
   the governance beat it is (the branch, contract, tests, and gates are all
   there; only the judge verdict blocks).

Also observed, not fixed: Claude's structured replies for page specs
arrived with raw control characters inside JSON strings on three of nine
wave-1 pages, each costing one repair retry (self-healed); the extraction
judge's context is narrower than the analyst's closure, so it scored
`faithfulness` 1 for facts the analyst legitimately read from the servlet
and ESB sources; `convert-page` places `layout.tsx`, `registry.ts`, and
`components.css` edits outside the pack's `program-files`, so the judge sees
them only as a summary and returns three "cannot verify" findings. Cost
figures were estimates throughout; the first wave-1 attempt alone reported
$12.26 estimated before it was stopped.
