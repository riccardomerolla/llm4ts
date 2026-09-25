# Internet-banking demo runbook — parallel stories from an epic

The demo: a retail internet-banking portal is replaced feature by feature by
coding agents working **in parallel**, each confined to its own story,
reusing the house kit. One epic — "Conto e Bonifico" — becomes eight stories
in three waves; the audience watches the board fill up, the branches merge,
and the portal grow. Every token and cost figure shown is an **estimate**
(character-count heuristics — the CLI seats report no usage); say so.

## Act 0 — before the audience arrives

Seed the target and warm its dependencies while online (the fixture commits
its lockfile; the seeded copy installs offline afterwards):

```bash
pnpm install --ignore-workspace --dir examples/internet-banking/portal
node examples/internet-banking/seed-portal.mjs ~/demo/portal
cd ~/demo/portal && pnpm install --offline && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All four gates must be green on the seeded copy: they are the flow's hard
gates, per task and after every merge. Start the portal once to know what
the audience will see (`pnpm dev`, http://127.0.0.1:5180, sign in as the
demo customer, switch languages).

Seats: the orchestrator is `claude` by default (`LLM4TS_REASONER=gemini`
for the Gemini CLI); the coders are `pi`. Both CLIs must be installed and
authenticated on the machine; `llm4ts doctor` lists what it finds. Prove
each one answers a trivial prompt before the session — `claude -p "OK"`
and `pi -p "OK"` — and put pi on a provider with real capacity: its
default free-tier model allows a handful of requests a day, and a story
needs dozens.

```bash
export LLM4TS_CONTEXT_BUDGET=120000              # bound diffs handed to the judge
export LLM4TS_CODER_MODEL=openai-codex/gpt-5.5   # pi: provider/model with capacity
```

Every story runs in its own worktree, a fresh checkout that is installed
with `pnpm install --offline` from the store you warmed above before the
coder starts (`LLM4TS_WORKTREE_SETUP` overrides the command).

## Act 1 — the split (plan only)

```bash
llm4ts run epic-stories --repo ~/demo/portal -- --plan-only \
  "Add the retail customer's current account (Conto) with balance and movements, and wire transfers (Bonifico) with beneficiary, review, SCA confirmation, and history."
```

Open `~/demo/portal/.llm4ts/epics/<epic-id>/plan.md` with the audience:
the waves, then each story's owned paths, shared read-only paths, and what
it provides. This is the approval gate — the human reads the plan before
any coder runs. If the split is off, edit the fenced block and rerun the
same command: the file wins over regeneration, and validation prints every
violation (overlapping ownership, cycles, unknown dependencies) at once.

The expected split is committed at
`flows/fixtures/epic-stories/conto-bonifico.md`; compare, or copy it over
the generated file to make the run deterministic.

## Act 2 — the parallel run

```bash
llm4ts run epic-stories --repo ~/demo/portal -- --concurrency 3
```

No epic text this time: the flow's default epic is the Conto e Bonifico
sentence from Act 1, and the epic's state (plan, board, stories) is keyed by
that text. Retyping it risks a one-character difference, which the flow
would read as a new epic with a new plan.

What to show while it runs:

- `~/demo/portal/.llm4ts/epics/<epic-id>/board.md` — planned, active,
  waiting, done, failed. Wave 1 (two contracts and the IBAN field) runs
  three at once; the four screens follow under the cap; `home` waits for
  all of them.
- `git -C ~/demo/portal worktree list` — one worktree per active story,
  under `~/demo/portal.worktrees/<epic-id>/` beside the repository (never
  inside it: the epic checkout must stay clean, and the run stops launching
  stories if a coder writes there).
- `git -C ~/demo/portal log --oneline epic/<epic-id>` — a merge commit per
  story, in dependency order, each one gated.

Talk track: the coder never waits — dependencies were declared up front,
and a story starts only after what it needs has merged. A story that finds
it needs something unplanned stops with `BLOCKED_ON:`. The flow checks the
claim against the plan (and the reasoner reads the named files). A wrong
claim sends the coder back once; a real one fails typed. You edit the plan
and rerun, and everything already merged is skipped.

With a local coder (LM Studio, Ollama) use `--concurrency 1`: the server
generates one reply at a time. Load the model with at least 128K of context
and no idle TTL. If the engine crashes mid-run, the flow waits for it to
answer again and retries the story instead of failing the rest.

### With a pool of executors (ADR 0019)

Instead of one coder, give the run a roster: the self-hosted models code
first, codex and then claude take the overflow, and claude (then codex)
reviews and judges, never the story it coded itself.

```bash
mkdir -p ~/.config/llm4ts
cp examples/internet-banking/roster.example.json ~/.config/llm4ts/roster.json
llm4ts roster
llm4ts run epic-stories --repo ~/demo/portal -- --concurrency 3
```

What to show while it runs:

- the run header lists the executors instead of a coder;
- `roster:` lines say who takes which story, who judges it, and who is out
  of the round (a usage limit, until its reset time; an LM Studio or
  Lemonade engine that is down, until its health URL answers);
- a story whose coder is taken out mid-task hands over to the next one,
  which continues in the same worktree;
- the board names each story's coder, and `report.md` sums the estimates
  per executor;
- `llm4ts roster pause codex --for 2h` keeps codex out of this run and the
  next; `llm4ts roster resume codex` brings it back.

The example assumes an opencode provider named `lemonade` for an on-prem
Lemonade Server at `192.0.2.10:13305`: change the host in the two `health`
URLs, and the `lemonade/` prefix of the two models, to the provider id and
address in your `~/.config/opencode/opencode.json`.

`--roster none` runs with one executor per seat as before;
`--executors pi-lmstudio,claude` narrows the roster for one run. One server
is one executor: never point two executors at the same LM Studio.

## Act 3 — the result

```bash
cd ~/demo/portal && git checkout epic/<epic-id> && pnpm test && pnpm dev
```

Sign in, open Conto, Movimenti, Bonifico (confirm with any six-digit code;
`000000` is refused), Bonifici, in Italian and in English. Then open
`.llm4ts/epics/<epic-id>/report.md`: per story the branch, the judge
verdict, and the estimated tokens and cost, labelled as estimates.

## Act 4 — landing the epic

```bash
llm4ts run epic-stories --repo ~/demo/portal -- --land
```

`--land` runs no stories. It refuses an epic with stories not merged, then
merges `main` into the epic branch, so any conflict is resolved on the epic
side. The coder resolves conflicts and red gates, up to three rounds. Only a
green epic reaches `main`, as one merge commit. If it cannot get there, the
epic is rolled back and `main` is untouched. `--land=<branch>` lands on
another branch. Afterwards the repository is on `main`, with the epic in its
history.

## Crash recovery (demonstrate it if you get the chance)

Interrupt the run during wave 2 and rerun the same command. Merged stories
are skipped ("already merged"), the interrupted ones resume from their task
checkpoint in their worktree, and a story whose plan entry you edited in
between starts over on a fresh branch. A failed story's dependents go on
hold — `waiting for <story>` on the board; fix the plan or the story and
rerun, and they start as soon as it merges.
