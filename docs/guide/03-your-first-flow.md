# 3. Your first flow

A flow is one TypeScript file. The shell ships one that needs nothing at
all, `hello`, and the shortest path to your own flow is to copy it.

## Run the built-in

```bash
llm4ts run hello "What is llm4ts?"
```

`LLM4TS_PROVIDER` is unset, so the flow picks the mock provider and prints
canned text. That is the point: the run loop, the terminal rendering, and
the cost summary are proven before any key or agent is involved.

## Copy it into your project

A flow in `.llm4ts/flows/` of the directory you launch from is discovered
by name, runs with Node's type stripping, and resolves its imports from the
shell's own installation, so this step installs nothing:

```bash
mkdir -p .llm4ts/flows
llm4ts view hello > .llm4ts/flows/hello.ts
llm4ts list          # hello  [project shadows builtin]  Hello: send one prompt ...
```

Your copy now shadows the built-in of the same name. Rename the file, or
change its first comment line, and it is your flow. `view` prints the
shipped JavaScript build of the flow, which is valid in a `.ts` file; this
is the same program as it reads in the source:

<!-- prettier-ignore -->
```ts
// Hello: send one prompt to the configured provider and print the answer.
import * as Effect from "effect/Effect"
import {
  apiConnectorFromEnvironment,
  completeAndPublish,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Say hello and name one thing you can do.")
  const coder = yield* apiConnectorFromEnvironment()
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      environment: process.env
    },
    (context) => completeAndPublish(context.coder, context.events, input.prompt)
  )
})

runFlowMain(program)
```

## Every line, once

- **The first `//` line** is the description `llm4ts list` shows. It must
  be the first non-blank line.
- **`@llm4ts/runner`** is the one import a flow needs: it re-exports the
  runner and flow verbs a script uses. Everything else stays reachable on
  the package subpaths the [API guide](../api.md) lists.
- **`resolveFlowInput(default)`** parses the arguments `llm4ts run` forwards:
  the task text, or `default` when there is none, and `--repo`. It returns
  `prompt`, `workDir` (the target repository) and `workspace` (where you
  launched from).
- **`apiConnectorFromEnvironment()`** reads `LLM4TS_PROVIDER` and
  `LLM4TS_MODEL`. `mock` needs nothing; `openai`, `anthropic`, `gemini`,
  `lm-studio`, and `ollama` need a model name and, for the cloud ones, the
  standard key variable.
- **`runNode(input, body)`** builds everything the body needs and hands it
  over as `context`. You never construct services or layers.
- **`completeAndPublish(service, events, prompt)`** sends one prompt and
  publishes the answer as an event the terminal renders.
- **`runFlowMain(program)`** runs the program, renders events, prints the
  cost summary, and sets the exit code.

```mermaid
flowchart LR
  subgraph runNode["runNode(input, body)"]
    direction TB
    H["HTTP client"] --- P["process executor"] --- T["temp files"]
    S["plain file store<br/>(persistence)"] --- R["connector registry"] --- E["event sink<br/>(terminal, trace)"]
    B["your body(context)<br/>context.coder · context.reasoning<br/>context.events · context.git · context.workspace"]
  end
  I["input: workDir, workspace,<br/>userPrompt, coder"] --> runNode
  runNode --> X["exit code · cost summary"]
```

## Point it at your coding agent

Replace one line, and add one name to the import:

<!-- prettier-ignore -->
```ts
import { coderFromEnv /* , ... */ } from "@llm4ts/runner"
// ...
  const coder = coderFromEnv(process.env)
```

Now `llm4ts run hello "Summarise this repository in three lines"` sends the
prompt to the CLI named by `LLM4TS_CODER`, running inside `workDir`, with
the agent's tool calls streamed to your terminal. Everything else is
unchanged.

## Optional: editor types

The zero-install path gives you no autocompletion. When you intend to write
more than a hello flow, add the packages to the project that holds
`.llm4ts/flows/`:

```bash
npm i -D @llm4ts/runner @llm4ts/flow @llm4ts/core effect@beta
```

Your project's copies now win over the shell's fallback, so keep them on the
same versions as the shell, and keep `effect` pinned exactly rather than
with a caret: the Effect 4 line is a beta, and a caret range drifts past the
version llm4ts was built against.

Next: [4. Fork a built-in](04-fork-a-built-in.md).
