# `mlx-lm` Connector With Label Log-Probabilities

Order: after `lmstudio-structured-output` (independent) and before
`core-judgment` can use the `logprobs` path. Depends on the `scoreLabels`
primitive defined in `core-judgment`; implement that primitive first if this
spec is picked up alone. ADR 0017.

## Why

A judgment needs no generation when the backend exposes token
log-probabilities: one forward pass, one output token, the distribution
read off the option labels. LM Studio and Ollama do not expose them;
`mlx-lm`'s server (`python -m mlx_lm.server`) does, runs natively on Apple
Silicon, and loads the Hugging-Face-format MLX weights LM Studio keeps under
`~/.lmstudio/models/<publisher>/<Model>-MLX-4bit/`, so nothing is
downloaded twice.

## Facts (2026-09-19)

- OpenAI-compatible `POST /v1/chat/completions` with request fields
  `messages, max_tokens, temperature, top_p, logit_bias, logprobs (int), stop, stream`.
  Its logprobs are not OpenAI-shaped: `logprobs.tokens` are token ids,
  `logprobs.top_logprobs` is a list (per generated token) of `{tokenId: logprob}`.
- No `response_format`; structured output is prompt-coerced through
  `parseFromText` like the CLI connectors.
- Prefix cache covers the most recent prompt only, so sequential calls that
  share the state prefix are the fast path (drives `LlmJudgment.concurrency`
  default 1).
- Spike result: see the "Spike" section below once recorded.

## Tasks

- [ ] `Models.ts`: `Provider.MlxLm`, connector id `mlx-lm`, default base URL
      `http://localhost:8080`, in `apiConnectorIds`; `withConfigDefaults`
      and the runner's `enrichApiConnector` pick it up unchanged.
- [ ] `providers/MlxLmProvider.ts` via `makeApiConnector`: streaming over
      `/v1/chat/completions` (OpenAI chunk schema, reuse the OpenAI
      schemas), structured via `withSchemaHint` + `parseFromText`, tools
      unsupported (typed `InvalidRequestError` like LM Studio), health via
      `GET /v1/models`.
- [ ] `scoreLabels(prompt, labels)`: `max_tokens: 1`, `temperature: 0`,
      `logprobs: true, top_logprobs: 11`, read the first generated position's `top_logprobs`,
      map token ids to labels, renormalize over labels present. Return
      method `logprobs` and `support` = the absolute mass on the labels.
      Labels absent from the top-k: fail with a typed
      `LabelsNotObserved` error carrying the observed ids (the judgment
      layer decides on fallback).
- [ ] Label matching on token text (see Spike): strip the byte-level space
      marker, case-fold, sum the mass of every top-k entry that equals a
      label. No token-id probe is needed on mlx-lm 0.31+.
- [ ] Capabilities: `labelProbabilities: "logprobs"`, `structuredOutput: true`
      (prompt-coerced), tool calling false, `usageReporting` per what the
      server returns.
- [ ] Runner preset `mlxLm` next to `lmStudio`; `LLM4TS_PROVIDER=mlx-lm`.
- [ ] Register in `ConnectorFactories.ts`; provider-capabilities matrix row;
      `docs/configuration.md` note on starting the server against an
      LM Studio model directory.
- [ ] Tests with the in-src HTTP fake: streaming, structured decode, label
      scoring with a canned `top_logprobs`, missing-label failure, probe
      caching (second call makes no probe request).

## Spike (2026-09-19, recorded from the session that designed this)

Setup: `mlx-community/Qwen3-4B-Instruct-2507-4bit` (text-only, non-thinking,
1.6 GB) served by mlx-lm 0.31.3 for the log-probability path and by LM Studio
for the verbalized path, same weights. 20 hand-labeled atomic questions (10
Truth, 6 Choice, 4 Score) over short states shaped like llm4ts decisions.

| Method                          | Accuracy | Mean latency | Misses |
| ------------------------------- | -------: | -----------: | -----: |
| logprobs (1 token, top 11)      |    19/20 |       0.22 s |      0 |
| logprobs + reversed permutation |    19/20 |   2 × 0.22 s |      0 |
| verbalized JSON (LM Studio)     |    17/20 |       1.26 s |      0 |

Agreement between the two methods: 18/20. The verdict: the connector earns
its place on speed (about 6x) and accuracy, so ADR 0017's open question
closes in favour of building it.

Findings that change the design:

- The distributions are almost fully peaked: probability 1.00 on the chosen
  label for every question, including the one wrong Truth answer. A greedy
  instruct model's log-probabilities carry almost no uncertainty signal, so
  a `JudgmentPolicy` threshold on `logprobs` confidence will rarely trigger.
  Verbalized confidence was 0.95 on its wrong answers too. Neither local
  path is calibrated; the ADR's consequence stands and policy should treat
  local confidence as weak evidence.
- `permutations: 2` changed nothing on this sample; keep the default at 1.
- mlx-lm's `top_logprobs` is capped at 11; request 11, not 20.
- mlx-lm 0.31.3 returns OpenAI-shaped logprobs (`logprobs.content[0].top_logprobs`
  as `{ id, token, logprob }`), so token strings are available and the
  per-model id probe in the tasks above is unnecessary: match on the token
  text after stripping the byte-level space marker (`Ġ`, `▁`) and
  case-folding. The `id` field is kept only for diagnostics.
- mlx-lm 0.31.3 keeps an LRU prompt cache across requests
  (`fetch_nearest_cache`), not just the most recent prefix, so
  `concurrency` above 1 is safe; the default of 1 stays for memory reasons.
- LM Studio's community conversions of Qwen 3.5 and later are multimodal
  checkpoints (`Qwen3_5ForConditionalGeneration`) that mlx-lm cannot load
  (424 missing `language_model.*` parameters). Reuse of LM Studio's on-disk
  weights holds for text-only MLX models such as Qwen 3 and Qwen3-Coder; a
  multimodal model needs a text-only twin downloaded once.
- The Qwen3-4B-Instruct-2507 chat template accepts no `enable_thinking`
  switch; the connector must send `chat_template_kwargs` only for models
  that need it (a config flag, default off for mlx-lm).
