# Google Vertex AI with a service-account key

How to run llm4ts flows when the only model access you have is a Google
Cloud project with Vertex AI and a **service-account JSON key**: which
coding-agent CLIs can use it, how to configure each, and how to put them in
an executor roster.

llm4ts never authenticates to a model itself when a CLI harness is the
seat: each CLI owns its authentication (see "CLI connectors" in
`configuration.md`). What llm4ts does is start the CLI with your
environment, plus any variables a roster executor declares. So the setup is
two steps: make each CLI work against Vertex on its own, then describe the
combination in a roster.

The per-CLI facts below were checked against each tool's own documentation
and source on 2026-09-30; the links are at the end of each section. These
CLIs change quickly: if a variable is not accepted, check the linked page
first. What could not be verified from a primary source is listed under
[What is not verified](#what-is-not-verified).

## What works

| Harness (`harness` in a roster) | Vertex models    | Service-account key file | Roster `model` format                   |
| ------------------------------- | ---------------- | ------------------------ | --------------------------------------- |
| `claude` (Claude Code)          | Claude           | yes                      | `claude-sonnet-4-5@20250929`            |
| `gemini` (Gemini CLI)           | Gemini           | yes                      | `gemini-2.5-pro`                        |
| `opencode`                      | Gemini, Claude ¹ | yes                      | `google-vertex/<model>`                 |
| `pi`                            | Gemini           | yes                      | `google-vertex/<model>`                 |
| `codex` (OpenAI Codex CLI)      | none             | no                       | not usable with Vertex, see its section |

¹ Claude through opencode's `google-vertex-anthropic` provider is in its
source but not in its provider documentation.

The model ids are examples. Use the ids your project has enabled in Model
Garden; for Claude they carry a date suffix (`@20250929`).

## One-time setup in Google Cloud

Done by a project administrator, once per project:

```sh
PROJECT=my-bank-ai
gcloud services enable aiplatform.googleapis.com --project "$PROJECT"

gcloud iam service-accounts create llm4ts-agents --project "$PROJECT" \
  --display-name "llm4ts coding agents"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:llm4ts-agents@$PROJECT.iam.gserviceaccount.com" \
  --role roles/aiplatform.user

gcloud iam service-accounts keys create ~/.config/gcloud/llm4ts-agents.json \
  --iam-account "llm4ts-agents@$PROJECT.iam.gserviceaccount.com"
chmod 600 ~/.config/gcloud/llm4ts-agents.json
```

- `roles/aiplatform.user` ("Vertex AI User") is the role the Claude Code and
  Gemini CLI documentation name.
- **Claude models must be enabled** for the project in Vertex AI Model
  Garden before any call succeeds. Anthropic's documentation says approval
  can take 24 to 48 hours.
- The key file is a credential. Keep it outside every repository, readable
  only by the user who runs the flows, and rotate it on your organisation's
  schedule. llm4ts only ever handles its **path**.

## The shared environment

Every CLI below reads Application Default Credentials, so one variable
points them all at the key:

```sh
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/llm4ts-agents.json"
export GOOGLE_CLOUD_PROJECT=my-bank-ai
export GOOGLE_CLOUD_LOCATION=us-central1
```

Unset `GOOGLE_API_KEY` and `GEMINI_API_KEY` in that shell: where a CLI
accepts both, an API key takes precedence over Vertex.

You can export these once for every harness, or set them per executor in the
roster (below), which is what lets one executor use Vertex while another
uses a subscription.

## Claude Code (`claude`)

```sh
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=my-bank-ai
export CLOUD_ML_REGION=us-east5        # or global, eu, us
```

- Requests go to `ANTHROPIC_VERTEX_PROJECT_ID`, even when the key file
  belongs to another project.
- Not every Claude model is served from `global`; a region without the
  model answers 404. A per-model override exists, for example
  `VERTEX_REGION_CLAUDE_HAIKU_4_5=us-east5`.
- Select the model with the roster's `model` (it becomes `--model`), using
  the Vertex id: `claude-sonnet-4-5@20250929`. Claude Code also uses a
  small model for background work; pin both so a rollout does not drift
  with the CLI's defaults: `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`.
- The same variables may live in the `env` block of Claude Code's own
  settings file instead of the shell.

Source: <https://code.claude.com/docs/en/google-vertex-ai>

## Gemini CLI (`gemini`)

```sh
export GOOGLE_GENAI_USE_VERTEXAI=true
# plus GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION
```

- The key file is the method its documentation gives for non-interactive
  environments. Project and location are both required.
- `GOOGLE_GENAI_USE_VERTEXAI=true` is what selects Vertex without the
  interactive menu (the value must be the string `true`). The alternative
  is `security.auth.selectedType: "vertex-ai"` in the CLI's settings.
- Model: the roster's `model`, a bare id such as `gemini-2.5-pro`.
- `llm4ts doctor` recognises this setup: it reports "Vertex AI with
  GOOGLE_CLOUD_PROJECT=…" for the Gemini seat.

Sources: the `gemini-cli` repository,
[authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)
and
[configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md).

## opencode (`opencode`)

```sh
# GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT, plus:
export VERTEX_LOCATION=us-central1
```

- There is no switch: the `google-vertex` provider loads when a project
  variable is set.
- **Set the location explicitly.** Its documentation says the default is
  `global`; its source defaults Gemini to `us-central1`.
- Model: `provider/model`, so `google-vertex/gemini-2.5-pro` in the roster.
  Claude on Vertex goes through a second provider,
  `google-vertex-anthropic/<claude id>`.

Sources: <https://opencode.ai/docs/providers/>,
<https://opencode.ai/docs/models/>.

## pi (`pi`)

```sh
# GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION
```

- pi treats the provider as signed in only when credentials, project and
  location are all present.
- Model: `provider/id`, so `google-vertex/gemini-2.5-flash` in the roster.
- pi has no Claude-on-Vertex provider: Gemini models only.

Source: the `pi-mono` repository,
[providers](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md).

## Codex CLI (`codex`): not with a Vertex key

Codex has no Google or Vertex provider, and it cannot read a
service-account key: a custom provider only sends a bearer token. Its custom
providers also speak only OpenAI's Responses wire format, while Vertex's
OpenAI-compatible endpoint is documented as Chat Completions. Reaching
Vertex from Codex would need a translating gateway in front of it, which is
outside this guide. With only a Vertex key, leave `codex` out of the roster
and let `claude`, `opencode` or `pi` code.

Sources: Codex
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[provider source](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs).

## Check each CLI before llm4ts

Run each harness once by hand, in the shell that has the variables. A flow
cannot tell a missing role from a missing model from a wrong region; the
CLI's own error can.

```sh
claude -p "Reply with the word ready."
gemini -p "Reply with the word ready."
opencode run -m google-vertex/gemini-2.5-pro "Reply with the word ready."
```

Typical failures: `PERMISSION_DENIED` (the role is missing, or the Vertex AI
API is not enabled), 404 (the model is not enabled in Model Garden, or not
served from that region), and a CLI that silently uses an API key or a
subscription because `GOOGLE_API_KEY`, `GEMINI_API_KEY` or an earlier login
took precedence.

## A roster on Vertex

An executor is a harness plus a model, with the roles it takes. Its `env`
is given to that CLI on top of your shell's environment. Values may use
`${NAME}` to reference a variable of the environment llm4ts runs in; a
roster that references an unset variable is refused when it loads. Keep the
key's path and the project in variables, so the file has no machine-specific
value and can be shared by a team.

`~/.config/llm4ts/roster.json` (or `<repo>/.llm4ts/roster.json`); the same
file ships as `examples/vertex/roster.example.json`:

```json
{
  "executors": [
    {
      "id": "claude-vertex",
      "harness": "claude",
      "model": "claude-sonnet-4-5@20250929",
      "roles": ["planner", "reviewer", "judge", "verifier", "coder"],
      "slots": 3,
      "priority": { "coder": 2, "default": 1 },
      "env": {
        "CLAUDE_CODE_USE_VERTEX": "1",
        "ANTHROPIC_VERTEX_PROJECT_ID": "${VERTEX_PROJECT}",
        "CLOUD_ML_REGION": "us-east5",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5@20250929",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5@20251001",
        "GOOGLE_APPLICATION_CREDENTIALS": "${VERTEX_KEY_FILE}"
      }
    },
    {
      "id": "pi-gemini-vertex",
      "harness": "pi",
      "model": "google-vertex/gemini-2.5-pro",
      "roles": ["coder"],
      "slots": 2,
      "priority": 1,
      "env": {
        "GOOGLE_CLOUD_PROJECT": "${VERTEX_PROJECT}",
        "GOOGLE_CLOUD_LOCATION": "us-central1",
        "GOOGLE_APPLICATION_CREDENTIALS": "${VERTEX_KEY_FILE}"
      }
    },
    {
      "id": "opencode-gemini-vertex",
      "harness": "opencode",
      "model": "google-vertex/gemini-2.5-flash",
      "roles": ["coder"],
      "slots": 2,
      "priority": 1,
      "env": {
        "GOOGLE_CLOUD_PROJECT": "${VERTEX_PROJECT}",
        "VERTEX_LOCATION": "us-central1",
        "GOOGLE_APPLICATION_CREDENTIALS": "${VERTEX_KEY_FILE}"
      }
    },
    {
      "id": "gemini-vertex",
      "harness": "gemini",
      "model": "gemini-2.5-pro",
      "roles": ["reviewer", "verifier"],
      "slots": 2,
      "priority": 2,
      "env": {
        "GOOGLE_GENAI_USE_VERTEXAI": "true",
        "GOOGLE_CLOUD_PROJECT": "${VERTEX_PROJECT}",
        "GOOGLE_CLOUD_LOCATION": "us-central1",
        "GOOGLE_APPLICATION_CREDENTIALS": "${VERTEX_KEY_FILE}"
      }
    }
  ]
}
```

with, in the shell that runs the flows:

```sh
export VERTEX_PROJECT=my-bank-ai
export VERTEX_KEY_FILE="$HOME/.config/gcloud/llm4ts-agents.json"
```

What this roster does in `epic-stories`: the two Gemini coders take stories
first (priority 1), Claude codes when they are busy or out, and Claude
plans, reviews and judges. A story is never reviewed by the executor that
coded it while another can take the role. `llm4ts roster` shows the pool
and who is out; `llm4ts roster pause <id>` takes one out by hand.

Things specific to Vertex:

- **Quota is per project and per model, not per executor.** Two executors
  on the same model share one quota. Size `slots` to it; when a model's
  quota is exhausted, the roster puts that executor on cooldown and hands
  its work to the next.
- **Mixing Vertex with a subscription.** Because `env` is per executor, one
  `claude` executor can carry `CLAUDE_CODE_USE_VERTEX=1` and another can
  omit it and use the signed-in subscription. Give them different ids and
  priorities.
- **Several projects or regions**: one executor per project or region, each
  with its own `env`. For Claude, set `ANTHROPIC_VERTEX_PROJECT_ID`
  explicitly on each.
- **Never put the key's contents in a variable or in the roster.** Only the
  path. The roster's `env` is for references and non-secret settings.

## Without a key file

Application Default Credentials has two other sources that these CLIs pick
up the same way, with the rest of this guide unchanged:

- a developer's own login (`gcloud auth application-default login`), where
  no `GOOGLE_APPLICATION_CREDENTIALS` is set;
- workload identity federation, where `GOOGLE_APPLICATION_CREDENTIALS`
  points at a credential configuration file and no long-lived key exists.
  This is the option to prefer in CI where your organisation forbids
  service-account keys.

## What is not verified

Stated so nobody relies on it by accident:

- opencode's exact model ids on Vertex, its Claude-on-Vertex provider
  (present in source, absent from its documentation), and which location
  default its released build uses.
- `global` as a location for Gemini CLI and for pi.
- The IAM role pi and opencode need (the Vertex AI User role is what the
  Claude Code and Gemini CLI documentation name, and what this guide
  grants).
- The workload identity path, per CLI. It is standard Application Default
  Credentials behaviour, not something each CLI documents.
- Any route from Codex to Vertex.
- The smoke-test commands above are each CLI's non-interactive mode as of
  the same date; pi's is left out because its flag was not confirmed.
