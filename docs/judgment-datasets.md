# Labelling a decision

Use `pnpm judgment:label seed <decision>` to create candidates, edit the pending
JSONL file, then run `pnpm judgment:label promote <decision>`. Inspect progress
with `pnpm judgment:label status <decision>`.

```bash
pnpm judgment:label seed review-prescreen --commits 10
pnpm judgment:label status review-prescreen
pnpm judgment:label promote review-prescreen
```

Run from the repository root. Review seeds use recent non-merge commits and the
same seven lenses and 60,000-character diff cap as `judgment:replay`. Each item
contains `{ "diff": "…" }` and the lens's actual screening statement. Label the
provided diff per lens: `true` means the lens would report at least one concrete
issue; `false` means none. Check the full commit when needed, and keep the saved
state representative of what the scorer will receive.

For `satisfied-probe` and `program-judge`, seeding reads
`.llm4ts/judgments/<decision>.jsonl`. Override it with `--observations <path>`.
Enable observation logging and exercise the consumer first if no records exist.
State and questions are copied verbatim; answers and outcomes are never used as
human labels. Satisfied-probe uses a boolean: does the reply say the task was
already satisfied without changes? Program-judge uses an integer index into the
question's ordered `criteria`, one item per recorded rubric dimension.

Candidates go to `tools/judgment/datasets/<decision>.pending.jsonl`. Add `label`,
`labelledBy` (your name), and `labelledAt` (an ISO timestamp, for example
`2026-09-20T12:00:00Z`) to each record. Keep `id`, `source`, `state`, and `question`
unchanged. Repeated seeding skips IDs already in either file, preserving edits.
Observation IDs include timestamp and log line position to distinguish repeated
questions within one run; seed from the original append-only log.

Promotion validates the entire batch before writing. Items nobody has labelled
yet (label absent or null) simply stay pending, so a set can be built in
batches. A label that is present but of the wrong kind, or a score index
outside the question's scale, causes a typed failure with the affected IDs and
a non-zero exit, leaving both files unchanged. Complete records move to
`<decision>.jsonl`; records with a valid label but missing, blank, or invalid
attribution stay pending. Status counts only
fully valid records as `labelled-pending`. Dataset IDs already present are skipped
on promotion retries. Dataset append happens before the atomic pending rewrite,
so an interrupted rewrite can be retried. Run one labelling command at a time.

Build **30–100 human-labelled items per decision** for the evaluation baseline.
The tool permits smaller batches while building the set; it does not invent
labels or enforce the final sample size. These are held-out evaluation data:
exclude the selected states and their source observations from all scorer
training, including copies in the observation logs.

## Running the evaluation

Run a backend against the labelled set with:

```bash
pnpm judgment:eval review-prescreen --backend llm \
  --out docs/judgment/evals/2026-09-20-review-prescreen.md
```

The default dataset is `tools/judgment/datasets/<decision>.jsonl`. Override it
with `--dataset <path>`; use `satisfied-probe` or `program-judge` for the other
decisions. Each item is asked independently, sequentially by default;
`--concurrency N` permits multiple independent requests in flight. `--out`
writes the Markdown also printed to stdout; without it no report is saved.

`--backend llm|typesafe|fake` overrides environment selection. Otherwise the
runner's rule applies: `LLM4TS_JUDGMENT_BACKEND=typesafe` selects TypeSafe,
and other values select `llm`. The LLM uses the existing runner registry and
`LLM4TS_JUDGMENT_PROVIDER` / `LLM4TS_JUDGMENT_MODEL`, falling back to
`LLM4TS_PROVIDER` / `LLM4TS_MODEL` when no judgment provider is set. TypeSafe
requires a nonblank `TYPESAFE_API_KEY`; the key is kept Redacted and is never
printed. `fake` needs no credentials and returns the existing fake's defaults
(Truth=1, Score=level 0), independently of the labels.

For a local LLM server, add `--pid <server-pid>` to sample server RSS before
and after the run. The report marks memory unavailable without a PID and
describes the sampled-peak limitation. Dataset and backend request failures
exit non-zero; per-question failures are counted in the report.

`pnpm judgment:replay --commits 30` evaluates the pre-screen against outcome-derived
labels, not human labels: each commit/lens is positive when its full review reports
at least one issue. It reuses the act-mode screen's answers and decisions, reports
ECE, Brier and missed positive lenses, and counts the issues on missed lenses by
Critical/Warning/Info severity, asserting agreement with the replay's lost issues.
The missed rate divides missed lenses by answered positive lenses; missing screen
answers count as failures, and a failed full review aborts because it cannot supply
a label. Screening latency is divided evenly across all questions; percentiles
exclude unanswered items. Reviewer-seat and judgment-seat tokens stay separate.
Calibration is informational; acceptance remains zero Critical lost and at least
40% fewer reviewer-seat tokens. `--out <path>` saves the complete Markdown; both
evaluation tools prepend command, environment set/unset status and git provenance
when saving under `docs/judgment/evals/` (replay adds its inclusive commit range).

See [evaluation baselines](judgment/evals/README.md) for metric definitions,
severity limitations, and the exact-command/environment record to include
when committing a report as a fixed baseline.
