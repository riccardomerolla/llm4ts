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
`opencode`. The llm4zio-era `LLM4ZIO_CODER` name is no longer read (2.0).

`LLM4TS_VERBOSITY` accepts `quiet`, `normal`, `verbose`, or `debug`.

### Gemini ACP bridge (for `pi` without a model credential)

When `pi` is the coder and the only paid model access available is a
`gemini-cli` OAuth subscription (no `GEMINI_API_KEY`, no Vertex key), a
`pi`-coding flow run can start a local bridge that lets `pi` draw its
inference from that subscription instead. Set `LLM4TS_GEMINI_BRIDGE` (any
truthy value) to start it, scoped to that flow run; `LLM4TS_GEMINI_BRIDGE_PORT`
overrides the fixed port (default `8731`) the bridge binds. Concurrent flow
runs sharing one bridge are unsupported — a run that finds the port already
bound fails fast rather than sharing an unowned server.

The bridge does not configure `pi` for you: add a custom provider to
`~/.pi/agent/models.json` with `baseUrl` set to `http://127.0.0.1:<port>`
(`api: "anthropic-messages"`) once, outside any flow run — `llm4ts doctor`
reports whether that file already points at the configured port but never
writes it (that file belongs to `pi`, not llm4ts).

```json
{
  "providers": {
    "gemini-bridge": {
      "baseUrl": "http://127.0.0.1:8731",
      "api": "anthropic-messages",
      "models": ["gemini-2.5-pro"]
    }
  }
}
```

Pointing that file at the bridge is necessary but not sufficient: `pi`
selects a provider per invocation, so the run must also be told to use this
one with `--model <provider>/<model>` (`gemini-bridge/gemini-2.5-pro` for
the entry above). The two ways to get that wrong fail differently — no
`--model` at all uses pi's own default and fails with `No API key found for
selected model`, while a name absent from the provider's `models` list
fails with `Model not found`. Both mean the bridge is up and nothing is
routed to it.

`llm4ts doctor` resolves the file and prints every pair pi will accept,
marking the bridged ones:

```sh
LLM4TS_GEMINI_BRIDGE=1 llm4ts doctor
```

From a source checkout, `pnpm build && LLM4TS_GEMINI_BRIDGE=1 pnpm llm4ts
doctor` runs the working tree's CLI instead of the installed release.

```text
prerequisites:
  ✔ pi-gemini-bridge: a provider in ~/.pi/agent/models.json points at 127.0.0.1:8731
      bridge models — pass one as LLM4TS_GEMINI_BRIDGE_MODEL (pi's --model):
        gemini-bridge/gemini-2.5-pro
```

The ADR 0016 smoke test (`examples/gemini-acp-bridge-smoke.ts`) reads the
same list rather than assuming a name: with exactly one bridged pair it uses
it, and otherwise asks for `LLM4TS_GEMINI_BRIDGE_MODEL`. That value only
routes pi — the bridge echoes it back and never forwards it, so gemini
reasons with `LLM4TS_GEMINI_MODEL` instead.

See ADR 0016 for the full design.

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

## Kits and packs

The modernization and conversion flows read a pack selected by `LLM4TS_PACK`
(or `llm4ts run --pack`; default `cobol-springboot`): a bare pack name
resolved across the kits discovered in the project (`./.llm4ts/kits/`),
global (`~/.config/llm4ts/kits/`, honouring `XDG_CONFIG_HOME`), and built-in
tiers; `kit/pack` to name one kit; or a directory holding `pack.md`, relative
to the launch directory or absolute, for a pack not yet in a kit. Two kits of
one tier shipping the same pack name is an error naming both. `llm4ts kits`
lists the kits with their packs and flows (ADR 0014).

Estate reading is bounded by `LLM4TS_MAX_READ_BYTES` (per file, 8 MiB in the
estate-reading phases), `LLM4TS_MAX_DISCOVER_RESULTS` (20 000 there, 1 000
elsewhere), and `LLM4TS_EXCLUDE_DIRS` (replaces the pruned directory list).

## Capabilities

Filesystem, process, network, Git, and forge operations require explicit
capability grants at the flow boundary. Connector capabilities describe what a
backend supports; grants describe what a particular run may do. They are
separate checks.

## Modernization

The phases persist their own artifacts under `docs/modernization/` of the
repository they run in. The source-compatible approval marker is
`- [x] Approved`:

- approve `docs/modernization/wave-plan.md` before extraction;
- approve `docs/modernization/README.md` before seeding.

Phase bodies receive their LLM, repository, workspace, and forge dependencies
through `runNode`; no provider is selected inside the flow package.
