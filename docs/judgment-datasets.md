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
