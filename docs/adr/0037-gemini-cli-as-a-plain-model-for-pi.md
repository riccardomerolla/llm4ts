# ADR 0037: Gemini CLI As A Plain Model For pi

Status: Proposed · Date: 2026-10-10 · Extends ADR 0016

## Context

A customer runs `epic-stories` with a roster of pi on Vertex and Gemini CLI,
and wants pi for coding on the Gemini subscription their procurement allows,
which reaches Google only through Gemini CLI's own login. On the same task
and model, pi spent visibly fewer tokens than Gemini CLI. Part of that gap
is how llm4ts counts: Gemini CLI's total includes cached input, pi's does
not. The rest is the harnesses. Gemini CLI sends a large built-in system
prompt and about a dozen tool definitions on every turn, loads its context
files, and starts sub-agents by default. pi sends a short prompt and four
tools.

ADR 0016 already lets pi run on that login: its bridge speaks Anthropic
Messages to pi and ACP to `gemini --experimental-acp`. But in that design
Gemini CLI stays the agent that calls the model, with its own prompt and
tools, and pi's tools come back to it through an MCP bridge. It keeps all of
Gemini CLI's overhead and adds pi's on top.

Two routes would make Gemini a plain model behind pi:

1. **Call the service directly** with the OAuth token Gemini CLI stores.
   Gemini CLI's terms (0.62.0, `docs/resources/tos-privacy.md`) rule this
   out: "Directly accessing the services powering Gemini CLI (for example,
   the Gemini Code Assist service) using third-party software, tools, or
   services … is a violation of applicable terms and policies. Such actions
   may be grounds for suspension or termination of your account." pi 1.1.0
   ships no subscription provider for it either (`google` and
   `google-vertex` only).
2. **Drive Gemini CLI itself as a model**, with two documented features:
   `GEMINI_SYSTEM_MD` replaces the whole built-in system prompt with a file
   (a full replacement, not a merge), and the settings `tools.core` (a
   built-in tool allowlist) and `experimental.enableAgents` switch off its
   own agent. Only Gemini CLI talks to Google, under its own login.

## Decision

1. **Never route 1.** llm4ts does not read, copy or forward Gemini CLI's
   credentials, and does not call Google's services for it.
2. **A model mode for the bridge.** The ADR 0016 bridge gains a second route,
   `POST /v1/chat/completions` in the OpenAI chat-completions shape,
   streaming as server-sent events. pi points at it as a custom provider in
   `~/.pi/agent/models.json` with `"api": "openai-completions"`, as it would
   at LM Studio. `LLM4TS_GEMINI_BRIDGE` still turns the bridge on;
   `LLM4TS_GEMINI_BRIDGE_MODE=model` selects this route, and `acp` (the
   default) keeps ADR 0016's.
3. **One Gemini CLI call per request.** Each request runs `gemini -p
--output-format stream-json -e none` in an empty scratch directory, with:
   - `GEMINI_SYSTEM_MD` pointing at a file the bridge writes: pi's system
     message, the tool-call protocol below, and pi's tool schemas;
   - `GEMINI_CLI_SYSTEM_SETTINGS_PATH` pointing at settings that allow no
     built-in tool and set `experimental.enableAgents: false`. It is the
     system _settings_ file, which overrides user and project settings; the
     system _defaults_ file llm4ts uses for `model.maxSessionTurns` is
     overridden by them, and the first probe run showed tools and sub-agents
     still active with it. Which allowlist removes every tool (`[]`, or one
     tool that does not exist) is the probe's to settle;
   - the conversation (user, assistant and tool messages) rendered as the
     prompt, in order, each tool result under the call it answers.
4. **Tool calls as text.** The model asks for a tool with one block,
   `<tool_call>{"name": "…", "arguments": {…}}</tool_call>`. The bridge
   parses it into an OpenAI `tool_calls` entry, so pi runs its own tools and
   sends the result in its next request. A malformed block or an unknown tool
   gets one corrective retry inside the same request; a second failure is
   returned as plain assistant text, which pi shows and the story's review
   loop handles like any other bad turn.
5. **Usage that compares fairly.** The response's `usage` carries uncached
   prompt tokens, output tokens (candidates plus thoughts), and
   `prompt_tokens_details.cached_tokens` from Gemini CLI's stats, so pi's and
   llm4ts's accounting keep cache reads apart. (The same correction to the
   Gemini CLI connector's own total belongs to ADR 0035's release.)
6. **The probe decides whether to build it.**
   `examples/gemini-model-probe.mjs` runs against a logged-in Gemini CLI and
   answers four questions: does the prompt override apply in headless mode,
   do `tools.core: []` and agents off remove every tool, how often does the
   model keep to the tool-call protocol, and does the override apply in ACP
   mode. Decisions 2–5 are built only if questions 1 and 2 pass and at
   least 9 calls in 10 are well-formed; otherwise this ADR is rejected with
   the probe's output as the record.
7. **The customer confirms compliance.** Route 2 uses only documented
   features and only Gemini CLI talks to Google, but using Gemini CLI as a
   model for another agent is close to the clause quoted above. `llm4ts
doctor` prints that clause when the model mode is configured, and the
   docs say the customer confirms with Google before relying on it.

## Consequences

- pi on the subscription pays pi's prompt and tools, not Gemini CLI's; what
  is left is the scratch-directory context, one Node start per turn (about a
  second or two), and the tool protocol's instructions.
- Tool calling is prompt-based, not Gemini's native function calling. It is
  less reliable; decision 4 bounds the cost of a bad turn, and the probe
  measures the rate before anything is built.
- Each request resends the whole conversation, as an OpenAI-shaped endpoint
  must. A stable prefix may still hit Google's implicit prompt cache; the
  probe's cached-token figures show whether it does. If question 4 passes, a
  later step can keep one ACP session per pi chat and send only new
  messages, recognising a continued chat by its message prefix.
- The bridge stays opt-in and local (loopback only), with no new runtime
  dependency (`node:http`, as ADR 0016's route).
- Tests drive the route against a fake Gemini executor that replays
  stream-json lines; CI needs no Gemini CLI, login or network.
- Diverges from `llm4zio` v4.2.0, which has no Gemini bridge; this ADR and
  ADR 0016 are the record.

## Running the probe

On a machine where `gemini` is logged in with the subscription (each stage
is one call against its quota):

```bash
node examples/gemini-model-probe.mjs --model gemini-2.5-pro --trials 10
```

The summary prints the four verdicts and the prompt tokens of a baseline
call, a call with the prompt replaced, and one with the tools removed too.
`--skip-acp` leaves out question 4.

## Probe run 1 (2026-10-10)

On the customer's Gemini CLI, with `gemini-2.5-pro` and `gemini-3.8-flash`:

- **Question 1, the prompt override, passes on both.** The canary came back
  in headless mode.
- **Question 4, the override in ACP mode, passes on both.**
- **Question 2 was not answered.** The settings went in the system defaults
  file, which the user's own settings override. With `gemini-2.5-pro`, the
  tool-protocol trials called Gemini's built-in tools natively (`glob`,
  `read_file`, `list_directory`, `google_web_search`, `invoke_agent`), so
  tools and sub-agents were still there. The stage-2 check passed only
  because the model declined to use a tool. The probe now writes the
  system settings file, tries two allowlists, and tells the model to use
  its tools.
- **Question 3, the tool-call protocol:** `gemini-3.8-flash` kept to it in
  10 of 10 calls, each the right tool with its argument. `gemini-2.5-pro`
  scored 0 of 10, all because it called the native tools it still had. It
  must be measured again once question 2 passes.
- **Tokens were not read.** This Gemini CLI reports stats in a shape the
  probe did not parse. The probe now reads both shapes and prints the raw
  stats of its first call.
