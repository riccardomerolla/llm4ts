# Judgment evaluation baselines

Commit reviewed reports here as fixed baselines, named
`<YYYY-MM-DD>-<decision>.md`. Keep the old report when evaluating a later
checkpoint; use a distinct filename for multiple backends or runs on one day.
The tool prints Markdown and writes a file only when `--out` is supplied. It
never commits a report. Fake runs are smoke checks, not model-quality evidence.

Record the **exact command and non-secret environment** that produced each
baseline alongside its generated tables. Include the git revision, dataset
path and content hash, provider, configured model and resolved checkpoint,
backend, concurrency, server version/start command, hardware, and PID when
measuring RSS. Record credential variable names as set/unset only; never paste
keys, authorization headers, full environment dumps, or credential-bearing URLs.
Preserve the evaluated dataset revision so the next checkpoint sees the same
held-out items. A moving alias such as `jev-latest` is not a fixed checkpoint;
retain the resolved response model printed in the report when available.

Example (replace model path and PID with the actual local server's values):

```bash
LLM4TS_JUDGMENT_PROVIDER=mlx-lm \
LLM4TS_JUDGMENT_MODEL=/models/checkpoint \
pnpm judgment:eval review-prescreen --backend llm \
  --dataset tools/judgment/datasets/review-prescreen.jsonl \
  --concurrency 1 --pid 12345 \
  --out docs/judgment/evals/2026-09-20-review-prescreen.md
```

## Reading the measures

Each request contains one item's state and question. Concurrency defaults to
one; `--concurrency N` allows independent requests in flight, without combining
states or questions. Latency includes the backend call, not queueing for a
concurrency slot, and uses nearest-rank p50/p95 over answered items.

Counts include all items. Accuracy, calibration, latency, and policy decisions
exclude failures; missing or wrong-kind answers count as failed. Overall
measures pool items, rather than averaging decision-level scores. An empty
denominator is `n/a`. The CLI refuses missing/empty datasets and datasets that
contain another decision. Dataset errors, initialization failures, request-level
backend failures, and file/RSS errors exit non-zero. Returned per-question
failures are counted and do not abort the run (including failures returned by
the LLM adapter). Inspect the failed count before comparing baselines.

Truth accuracy thresholds `truth >= 0.5`; Score accuracy rounds the expected
level index calculated from the probabilities. Let `p` be probability assigned
to the **human-labelled outcome**: `truth` or `1 - truth` for Truth, and the
labelled level's probability for Score. Brier here is `mean((1 - p)^2)`.
ECE uses ten equal-width bins `[0, 0.1), …, [0.9, 1]` and sums
`bin_count / answered * abs(1 - mean_bin_p)`. The observed labelled outcome has
target 1; this ECE therefore reduces to mean missing label probability.
These follow the task's label-probability contract and should not be compared
to conventional predicted-confidence ECE or full multiclass Brier scores.

Policy counts call `decide` with the default `JudgmentPolicy`. A pre-screen
miss requires a true label, `truth < 0.5`, and `decide === act`; its rate is
missed items / answered positive items. Held or cautious negatives would not
skip the lens. The current dataset has boolean presence labels, so the count
is missed **positive items**, not individual issues. Severity breakdowns are
unavailable until severity annotations exist; the report says so explicitly.

`--pid` is only for an LLM served by a local process explicitly identified by
the operator. RSS comes from `ps -o rss= -p <pid>`, converted from KiB to MiB.
Rest is sampled before the first request; sampled peak is the larger of rest
and the sample after the last request. It can miss transient peaks and is not
a continuous high-water mark. Without a PID, memory is marked unavailable and
no processes are guessed. Hosted TypeSafe and fake runs do not accept a PID.
