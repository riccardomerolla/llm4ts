# 7. Upgrade a spec pack

You extracted a legacy estate with an older llm4ts (say 0.16.2) and want to
continue with the current release: refine the pack with `modernize-refine`,
seed, implement. This chapter is that fork. It takes one branch, one
deterministic check, and one refine run.

**Needs:** a legacy repository with `docs/modernization/` written by any
earlier release, and the current `llm4ts` installed (`npx -y @llm4ts/shell`
works too).

## Why a check at all

The pack on disk has the same layout in every release since 0.16 — specs,
feature files, traceability and mapping fragments, the README with its
approval marker — so the newer flows can read it. Two things did change:

- Since 2.0.0 a page spec's `esbService` must be an identifier such as
  `ESB_ACCT_LIST`. A 0.16 pagespec block that says "the account list
  service" no longer decodes, and every 2.x phase that parses the block
  (`modernize-seed`, `convert-page`, `convert-feature`) refuses that page.
- The pack's coverage and survey rules may have changed with the kit, so
  `rules.txt` and the traceability index of an old pack can be stale.

Packs older than 2.2.0 also carry no `Written by llm4ts X.Y.Z` line in their
README, so nothing tells you which rules they were built under. The upgrade
flow answers all three questions without a model call.

## 1. Fork

Keep the old extraction as it was and continue on a branch:

```bash
cd ~/estates/legacy
git checkout -b modernize/llm4ts-2.2 modernize/spec-pack
```

`modernize/spec-pack` is the branch the old `modernize-extract` committed to.
Use the current release for everything from here on, with the `LLM4TS_*`
variable names: the `LLM4ZIO_*` aliases were dropped in 2.0.0.

## 2. Check the pack

```bash
llm4ts run modernize-pack-check --pack j2ee-nextjs-spa --repo ~/estates/legacy
llm4ts run modernize-pack-upgrade --pack j2ee-nextjs-spa --repo ~/estates/legacy
```

The first proves the current pack still matches the estate. The second
reads the old spec pack and, for every program: checks the four artifacts
are there, the feature file is well-formed Gherkin, and — when the pack
declares `spec-schema: pagespec` — the block decodes under the current
schema. It then regenerates `traceability.md`, `mapping.md`, and
`rules.txt` under the current coverage rules, stamps the README with the
version and an upgrade note, resets the README approval, and commits. It
exits 0 either way; the findings are the result:

```text
spec pack written by an llm4ts older than 2.2.0 (no version stamp); checking it as llm4ts 2.2.0
finding: accountOverview — pagespec block does not decode under the current schema: esbService …
finding: help — feature file missing
uncovered under the current rules: uncovered jsp-ajax: /accountOverview?fmt=json
2 program(s) need re-extraction — rerun with LLM4TS_MARK_DEEPEN=1, or add under '## Deepen' …
```

## 3. Mark what must be re-extracted

A program the current release cannot read is re-extracted, not patched by
hand: that keeps the pack source-grounded and judged. Let the flow write
the marks:

```bash
LLM4TS_MARK_DEEPEN=1 llm4ts run modernize-pack-upgrade --pack j2ee-nextjs-spa --repo ~/estates/legacy
```

`docs/modernization/decisions.md` now has one line per program under
`## Deepen`, each with the reason as its focus. Add your own marks while
you are there (chapter 5 of the runbook explains the vocabulary, and so
does the file's own header), or use the menu:

```bash
llm4ts refine --repo ~/estates/legacy --target ~/estates/nextjs
```

## 4. Continue with the current release

```bash
LLM4TS_TARGET_REPO=~/estates/nextjs llm4ts run modernize-refine --pack j2ee-nextjs-spa --repo ~/estates/legacy
```

Refine re-extracts the marked programs with the current prompts and judge,
one commit each, then proposes, consolidates, and plans as usual. Review
the README, `decisions.md`, and `domains.md`, flip `- [x] Approved` in
each, and the rest of the pipeline is the current one:

```bash
LLM4TS_LEGACY_REPO=~/estates/legacy llm4ts run modernize-seed --pack j2ee-nextjs-spa --repo ~/estates/nextjs
```

Uncovered units the check listed that no deepen closed are the closing
`modernize-extract` run's job, exactly as for a wave-by-wave extraction:
run it once without `LLM4TS_WAVE` and it extracts only what is missing.

## What you do not get

The old gate verdicts under `gate/` are fingerprinted over the rubric that
produced them; a changed rubric re-judges on the next refine or extract
run, which costs model calls but no rework. Provenance is written at seed,
so the target's `provenance.json` records the current version, the
upgrade note in the README records the old one.
