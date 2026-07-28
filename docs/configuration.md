# Configuration

## JavaScript facade

`createClient` validates a plain object:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `provider`       | `mock`, `openai`, `anthropic`, `gemini`, `lm-studio`, or `ollama` |
| `model`          | Provider model identifier                                         |
| `baseUrl`        | Optional endpoint override                                        |
| `apiKey`         | Optional secret; converted immediately to `Redacted`              |
| `timeoutSeconds` | Optional request timeout                                          |
| `temperature`    | Optional sampling temperature                                     |
| `maxTokens`      | Optional completion limit                                         |

API keys are sent in provider headers and are not placed in URLs, process
arguments, events, or persisted flow artifacts.

## CLI connectors

The Node runner exports presets for Claude, Codex, Gemini, Pi, Antigravity, Grok,
Cursor, and OpenCode. Their native CLIs own authentication. `LLM4TS_CODER`
selects `claude`, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, or
`opencode`. The source-compatible `LLM4ZIO_CODER` name remains a lower-priority
fallback.

`LLM4TS_VERBOSITY` accepts `quiet`, `normal`, `verbose`, or `debug`.

## API connectors

The runner exports `openAI`, `anthropic`, `geminiApi`, `lmStudio`, `ollama`, and
`mock` presets. Before registry resolution it fills a missing provider base URL
and reads a missing cloud credential from:

| Connector  | Environment credential                             |
| ---------- | -------------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`                                   |
| Anthropic  | `ANTHROPIC_API_KEY`                                |
| Gemini API | `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY` |

Explicit `baseUrl` and redacted `apiKey` values always win. LM Studio and Ollama
use their local default endpoints and require no credential. See the
[real examples](../examples/README.md) for runnable commands.

## Capabilities

Filesystem, process, network, Git, and forge operations require explicit
capability grants at the flow boundary. Connector capabilities describe what a
backend supports; grants describe what a particular run may do. They are
separate checks.

## Modernization

The default checkpoint is `docs/modernization/state.json`. The source-compatible
approval marker is `- [x] Approved`:

- approve `docs/modernization/wave-plan.md` before extraction;
- approve `docs/modernization/README.md` before seeding.

Phase bodies receive their LLM, repository, workspace, and forge dependencies
through public Effect composition. No provider is selected inside the
modernization state machine.
