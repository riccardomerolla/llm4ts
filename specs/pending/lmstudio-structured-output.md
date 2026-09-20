# LM Studio: Schema-Constrained Structured Output

Order: standalone, first. Nothing depends on it, but every local judgment
(ADR 0017) is only as trustworthy as this decode. No ADR.

## Why

`LmStudioProvider.executeStructuredWithUsage` (`packages/core/src/providers/LmStudioProvider.ts`)
prompt-coerces JSON through LM Studio's native `/api/v1/chat` endpoint and
parses the text. The same server accepts OpenAI-style
`response_format: { type: "json_schema", json_schema: { name, strict, schema } }`
on `/v1/chat/completions` with grammar-constrained sampling (verified on
2026-09-19 against LM Studio with an MLX model), and `streamRequest` already
speaks that wire format to that server.

Quirk observed: a thinking model (Qwen 3.6) put the constrained JSON in
`message.reasoning_content` with an empty `content`. Disable thinking for
structured calls (`chat_template_kwargs: { enable_thinking: false }`) and
fall back to `reasoning_content` when `content` is empty.

## Tasks

- [ ] Route `executeStructuredWithUsage` to `POST {base}/v1/chat/completions`
      with `response_format.json_schema` built from the `JsonSchema` argument,
      `strict: true`, thinking disabled; keep `parseFromText` as the decode
      step so fenced or padded replies still decode.
- [ ] Read `choices[0].message.content`, falling back to `reasoning_content`
      when `content` is empty; carry `usage` as today.
- [ ] Keep the health probe and streaming paths unchanged.
- [ ] Tests with the in-src HTTP fake: request shape (endpoint, `response_format`,
      thinking disabled), decode from `content`, decode from
      `reasoning_content`, typed `ParseError` on garbage.
- [ ] `docs/provider-capabilities.md`: LM Studio structured output is
      schema-constrained, not prompt-coerced.
