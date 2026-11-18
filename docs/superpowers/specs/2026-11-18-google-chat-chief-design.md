# Google Chat Chief of Staff: design

Status: built, accepted as [ADR 0052](../../adr/0052-google-chat-chief.md) ·
Date: 2026-11-18

## Intent

A prospect runs everything on Google. We want a proof of concept they can
watch in a Google Chat space: a Chief of Staff agent posts status updates
on llm4ts runs, answers questions about them, and starts work when someone
asks ("implement a new feature…"). The reference is the evening a Grok Bot
drove llm4ts from a chat (ADR 0041), with Google Chat as the chat.

The PoC must work with what one person can set up alone: a personal
Workspace user token, no agent account, no bot installed by an admin.

## Goals

- `llm4ts chat --space <space>` run in a repository binds that repository
  to one Chat space until it is stopped.
- A message starting with `/bot` in that space gets a reply in its
  thread.
- The Chief can answer questions about runs, start a flow, and stop a run.
- Run progress is posted to the space without anyone asking.
- State is markdown under the repository's gitignored `.llm4ts/`, so a
  restart continues where the last process stopped.
- Default CI needs no network, no Google credentials and no `gws` binary.

## Non-goals

- Google Tasks. Parked by the owner. Google's API cannot create a task in
  a space's Tasks tab; it can only read them.
- A real Chat bot (service account, cards, buttons, its own name).
- Several spaces or several repositories per process.
- Nightcall integration. The Chat tool is built so Nightcall can use it
  later; nothing in Nightcall changes now.
- Push delivery (Workspace Events over Pub/Sub). The PoC polls.
- "assign to…" as a feature. With tasks parked it has no target; the
  Chief answers such a request with what it can do.

## Anti-goals

- Anyone in the space being able to start coding runs on the repository.
- The Chief answering its own replies in a loop.
- A token, client secret or credentials path in process arguments, logs,
  traces, state files or error messages.
- A reply that claims something the run files do not show (the Grok Bot
  evening repeated a commit title that claimed green tests).

## Constraints

Checked against Google's documentation on 2026-11-18:

- User authentication needs a Business or Enterprise Workspace account, a
  Cloud project with the Chat API enabled and configured, and an OAuth
  client. A consumer Gmail account does not work.
- A message created with a user token is text only. Chat shows the user as
  the sender and the app's name beside it. No cards.
- `spaces.messages.list` supports user authentication (scope
  `chat.messages.readonly` or `chat.messages`), filters on `createTime`
  and `thread.name`, orders by `createTime`, pages up to 1000, and leaves
  out system messages.
- `spaces.messages.create` supports user authentication (scope
  `chat.messages.create` or `chat.messages`).

Not confirmed, to be checked first in the build (see Open checks):

- that `gws` exposes `spaces.messages.list` and passes `filter`,
  `orderBy` and `pageSize` through;
- that typing `/bot …` in a space with no app registering that command
  sends plain text.

From the repository:

- Effect 4 services and layers, schemas at boundaries, typed errors
  (`CLAUDE.md`).
- A decision made by a model is typed, never parsed from prose (ADR 0017).
- The runner knows nothing of the shell. The verb lives in `shell`; the
  Chat tool lives in `flow` beside `GitHubTool`.

## Approaches

**A. A new `llm4ts chat` verb.** Chosen. It polls the space, hands each
`/bot` message to a Chief of Staff seat, and acts through the run
supervisor that ADR 0041 built. State sits in `.llm4ts/chat/`. It needs no
GitHub, which suits an all-Google customer, and it matches what the owner
described: a run connects a repository to a chat. Cost: a verb and a Chat
tool.

**B. Chat as a front door to Nightcall.** `/bot implement…` files a
GitHub issue labelled `factory:ready`; Nightcall's pipeline does the work.
Most reuse, and the audit trail stays in GitHub. Rejected for now: the
customer would need GitHub, state would live in labels and not in
`.llm4ts`, and the Chief could answer only what the issue protocol knows.
The Chat tool from A makes this possible later.

**C. An existing chat agent with a Chat MCP in front of `llm4ts mcp`.**
Almost no code. Rejected: it repeats the Grok Bot setup, nothing owns the
polling loop, and the demo would depend on a third-party harness.

Transport, decided by the owner: wrap the `gws` CLI
(`@googleworkspace/cli`). It is not an officially supported Google product
and is pre-1.0, but it does the OAuth login, token storage and refresh,
and prints JSON. The official library `@google-apps/chat` and plain HTTP
would both leave login and refresh to us. The risk is held by a version
probe and by the tool's shape, which hides `gws` so plain HTTP can replace
it.

## Design

### Parts

```text
flow    GoogleChatTool     list and create messages through gws
flow    ChiefAction        the typed decision and its prompt
flows   chief              a read-only bundled flow: one decision per run
shell   ChatState          read and write .llm4ts/chat/*.md
shell   ChatLoop           poll → filter → decide → act → reply; run updates
shell   Cli                the `chat` verb
```

### GoogleChatTool (`packages/flow/src/GoogleChatTool.ts`)

Built like `GitHubTool`: pure functions that make argv, pure parsers that
decode JSON through schemas, and `makeGoogleChatTool(executor, cwd,
events)` returning a shape. Tests fake the process executor.

```ts
interface GoogleChatToolShape {
  readonly listMessages: (
    space: SpaceRef,
    after: string // RFC 3339 createTime, exclusive
  ) => Effect<ReadonlyArray<ChatMessage>, FlowError>
  readonly createMessage: (
    space: SpaceRef,
    text: string,
    thread?: ThreadRef
  ) => Effect<ChatMessage, FlowError>
}
```

`ChatMessage` carries `name`, `createTime`, `text`, `sender` (the user
resource name) and `thread`. `listMessages` pages until done and returns
messages oldest first. A reply sets the thread and asks Chat to fall back
to a new thread when the thread is gone.

`gws` is found on `PATH`. A version probe (the `versionProbe` pattern in
`packages/core/src/Connector.ts`; `GitHubTool` has none) runs once at
start and refuses a version outside the range the tool was written
against, naming the range.
Credentials are whatever `gws` already holds; llm4ts passes none and reads
none. Message text is passed as an argument, as `gh` bodies are today; it
is not a secret.

The tool needs only the Chat message scopes. It has no "who am I" call:
every route to one (People API, space membership, token info) needs a
wider scope. The owner's identity is learned from a message the Chief
posts (see Who may ask).

### ChiefAction (`packages/flow/src/ChiefAction.ts`)

One seat call per request, on the planner role. The output is typed
through `structuredAndPublish` (`packages/flow/src/Usage.ts`), the call
the taskforce Chief of Staff's plan uses, not parsed from prose:

```ts
type ChiefAction =
  | { _tag: "Answer"; reply: string }
  | { _tag: "StartRun"; flow: string; task: string; reply: string }
  | { _tag: "StopRun"; runId: string; reply: string }
  | { _tag: "Decline"; reply: string }
```

The prompt is given, as text collected by code:

- the request and who sent it;
- the flows that may be started (see Allowed flows);
- the runs in this repository, newest first, each with the one-sentence
  summary `summarizeTree` already produces (`runner/RunSummary.ts`), its
  state and cost;
- for the newest failed run, the bounded diagnosis the operator's
  `diagnose` tool returns;
- the last few entries of the request log.

The prompt tells the Chief to answer only from that text and to say so
when the text does not hold the answer. Code validates the action before
acting: the flow is in the allowed list, the run id exists, the reply is
non-empty and under Chat's message size limit. An invalid action is
retried once with the violations, as the taskforce plan is; a second
failure posts a fixed "I could not work that out" reply and logs the
request as failed.

This is the Chief's whole reach: it names one action and code acts.

**Where the call runs.** Nothing in `shell` calls a model today, and seats
exist only inside a flow process. So the decision is a small bundled
flow, `chief`, that the loop starts through the supervisor once per
request. It reads the request and the collected context from a file the
loop wrote, makes the one call, and writes the validated action to
`.llm4ts/chat/<space-id>/actions/<message-id>.json`. The loop waits for
it to exit and reads the file. This gives the call a roster seat, a
trace and a cost line with no new machinery, under the honest name
`chief`. `chief` joins `epic-retro` in the supervisor's `readOnlyFlows`,
so the Chief can answer while a writing run is busy. The loop leaves
`chief` runs out of the run list it hands the Chief, so it does not
report on itself; `llm4ts costs` shows them, which is right.

**The seat's hands.** As built (ADR 0052), the Chief runs on the
reasoner CLI named by `LLM4TS_REASONER`, toolless, and never on a roster
seat: the `chief` flow passes `roster: "none"`, so the seat that is
checked is the seat that is used. The request text is written by people
in a chat, so the flow refuses to start unless that CLI's read-only
grade is `enforced` (`readOnlyEnforcement`). The Chief can neither read
the repository nor run commands. A request that tries to talk it into
something else can at worst produce a wrong reply or a `StartRun` of an
allowed flow, which the sender was allowed to ask for anyway.

### ChatLoop (`packages/shell/src/ChatLoop.ts`)

A scoped Effect that owns a `RunSupervisor` (the one `llm4ts mcp` uses)
for this repository. Runs started from chat are its children. Stopping
`llm4ts chat` stops them the way stopping the operator server does (ADR
0041, decision 5), and a rerun of `llm4ts chat` marks them `lost` or
picks them up by the same rules.

Each beat (default every 5 seconds, `--interval`):

1. `listMessages(space, cursor)`.
2. Keep a message when its text starts with the trigger (`/bot`,
   `--trigger`), its `name` is not in the set of messages this process
   posted, its text does not start with the reply marker, and its sender
   is allowed. Advance the cursor past every message seen, kept or not.
3. For each kept message, in order: append it to the request log as
   `received`, decide, act, reply in the message's thread, and update the
   log entry with the action and the run id if any.
4. Persist the cursor.

Requests are handled one at a time. A failure while handling one posts a
short reply naming the kind of failure, logs it, and the loop goes on.
A failed `listMessages` is retried with backoff and never ends the loop;
a rejected login ends it with a message telling the owner to run
`gws auth login`.

**Replies.** Every message the Chief posts starts with a marker, default
`🌙 chief:`, and its `name` is recorded. Either check alone stops a loop;
both are kept because the marker survives a restart and the name set
survives a changed marker.

**Who may ask.** By default only the token owner. The owner's user id is
the `sender` of the "listening" line the Chief posts at start, stored in
`state.md`. `--allow <users/…>` (repeatable) adds others by user id, not
email: an email lookup needs a wider scope. Under `--observe` nothing is
posted, so with no stored owner id nobody is treated as allowed; the
verb prints each `/bot` sender's id and display name, which is how the
owner collects ids for `--allow`. A `/bot` message from
anyone else gets no action and one reply per sender per process saying
who may ask. This is the default because a `StartRun` writes code in the
repository.

**Run updates.** A second fiber follows every run the supervisor holds,
using the same event filter as the operator's `run_wait` (`Began`,
`StoryStatusChanged`, `StoryJudged`, `StageFailed`, `Aborted`,
`RunEnded`, and the capability and executor notices). It posts one line
per event batch into the thread of the request that started the run, at
most one message per run per 30 seconds, and always posts the end of the
run with outcome, duration and cost. No model is called.

Those seams are not enough for a plain run such as `implement`, and the
owner wants progress shown. `summarizeTree` is story-shaped, the
`run_wait` filter (`meaningfulKinds` in `RunReaders.ts`) does not hold
`Began`, and a healthy `implement` run emits none of its kinds before
`RunEnded`. So for a run with tasks and no stories the fiber also:

- reads the plan's task checkboxes on each beat (the reader `diagnose`
  uses for a plain run) and posts when the count of done tasks changes:
  "plan written, 4 tasks", then "task 2 of 4 done";
- at the end, reads the run's branch name and the number of commits it
  holds over the base branch, through the existing git tool, and adds
  them to the final line.

This is one pure function from (run kind, trace fold, plan tasks, git
facts) to a sentence, in `runner` beside `summarizeTree`, so the watch
views may adopt it. Story-shaped runs keep `summarizeTree`. The same
throttle applies; the final line is never dropped. A run not started from chat (from a
terminal while `llm4ts chat` is up) is not announced; the Chief can still
answer questions about it, because it reads the same traces.

**Allowed flows.** `--flows <name,…>`, default `implement`. The Chief is
shown only these. One writing run per repository at a time, as the
supervisor already enforces; a `StartRun` while one is running is turned
by code into a reply naming the running one.

**Starting a run.** Nobody sits at the run's terminal, so a flow that can
pause for its owner is started with `--no-pause`. That is per flow:
`roundtable` and `taskforce` parse it; `implement` has no pause and
rejects the unknown flag (`parseFlowArgs`), so it gets none. The flow
name and task go through the operator's `validateKnobs`
(`OperatorActTools.ts`), which already rejects a task starting with `-`
or `@`. The Chat message `name` is the supervisor's `requestId`, so a
crash between acting and saving the cursor cannot start the same request
twice. The reply says what was started and its run id.

**Branches.** `implement` creates its branch from the current HEAD, so a
second request would stack on the first one's branch. The loop records
the branch checked out when `llm4ts chat` started and returns to it
before each writing run. It refuses a `StartRun`, in words, when the
working tree is dirty. The work stays as commits on the flow's branch;
the PoC adds no push and no pull request.

**Shared registry.** The supervisor's run registry lives outside the
checkout (`~/.local/state/llm4ts/mcp/<repoId>/`) and is shared with any
`llm4ts mcp` on the same repository. The Chief sees those runs and may
stop them. That is accepted.

### ChatState (`packages/shell/src/ChatState.ts`)

Under `<repo>/.llm4ts/chat/<space-id>/`, through `PlainFileStore`:

- `state.md`: space, trigger, marker, cursor (`createTime` of the last
  message seen), the names of messages the Chief posted (bounded to the
  last 500), the owner's user id, the base branch.
- `requests.md`: append-only, one `### <createTime> <sender>` section per
  request with the text, the action, the reply, the run id, and the
  outcome once the run ends.

Both are markdown with a typed header parsed through a schema, the
file-as-state pattern of the roundtable and taskforce. On start, a
missing `state.md` sets the cursor to now, so old `/bot` messages in the
space are not replayed.

`.llm4ts/` is already in this repository's `.gitignore`. The verb warns
at start when the target repository does not ignore it, and continues.

### The verb

```text
llm4ts chat --space <spaces/AAAA…> [--trigger /bot] [--allow <who>]…
            [--flows implement,…] [--interval 5] [--marker "🌙 chief:"]
            [--observe]
```

`--observe` reads and decides but posts nothing and starts nothing; it
prints what it would do. It is how the owner tries the setup on a real
space before arming it, as Nightcall's observe mode does.

At start it checks, and stops with a plain message on failure: `gws`
found and in range, the space can be listed, the planner seat passes the
check under The seat's hands. It then
posts one line to the space saying the Chief is listening, which
repository it is bound to and which flows it may start, unless
`--observe`.

Settings go through the settings registry (ADR 0049) so the space and
trigger can live in the project's `config.env`.

### Setup, for the owner (documented, not coded)

A `docs/` page walks through: install `gws`; `gws auth setup` or a manual
Cloud project with the Chat API enabled, the Chat app configured with a
name, and a Desktop OAuth client; add the account as a test user; `gws
auth login` with the Chat message scopes only; find the space id; run
`llm4ts chat --observe`. The repository's `wizard` skill fits if the
owner wants it scripted.

### Tests

- `GoogleChatTool`: argv builders and parsers against recorded `gws`
  JSON; version probe accepts and refuses; a login failure maps to its
  typed error.
- `ChiefAction`: validation of each variant; the retry on an invalid
  action; the prompt contains the allowed flows and run summaries and no
  path outside the repository.
- `ChatLoop`, with a fake Chat tool, a fake seat and the supervisor's
  fake process: the Chief ignores its own messages by name and by marker;
  a stranger is refused once; the cursor advances past ignored messages;
  a restart does not replay; `StartRun` starts one run and a second is
  refused in words; run events become throttled thread replies and a
  final line; `--observe` posts and starts nothing.
- `ChatState`: round trip, bounded posted-names set, missing file.

All deterministic with `@effect/vitest`; no network, no `gws`.

### Open checks, first tasks of the build

1. Install `gws` on the owner's machine and confirm `chat spaces messages
list` exists and honours `filter`, `orderBy` and `pageSize`, and what
   its JSON looks like. Record a sample for the parser tests. If `list`
   is missing or the filter is dropped, stop and return to the owner:
   the fallback is plain HTTP for the two calls, with the access token
   read from `gws`.
2. Confirm that `/bot hello` typed in the PoC space arrives as plain
   text. If Chat intercepts it, change the default trigger to `@bot`
   or `bot:`.

### What a demo looks like

```text
Riccardo   /bot what is running?
Riccardo   🌙 chief: Nothing is running. The last run, implement
           (op-…-3fa2), finished green 40 minutes ago: 3 tasks, $0.82.
Riccardo   /bot implement a CSV export on the orders page
Riccardo   🌙 chief: Started implement as op-…-9c1e. I will post
           progress here.
Riccardo   🌙 chief: op-…-9c1e: plan written, 4 tasks; task 1 of 4.
Riccardo   🌙 chief: op-…-9c1e finished green in 11m, $1.37. Branch
           llm4ts/csv-export, 4 commits.
```

Every line is under the token owner's name, with the app's name beside
the Chief's lines. That is the visible cost of the personal token.

## Decisions the owner made

- Approach A, a new `llm4ts chat` verb.
- Transport: wrap `gws`.
- Personal user token; no agent account.
- The process fetches the chat and reacts to a command such as `/bot`.
- One run binds one repository to one space.
- State is markdown in the gitignored `.llm4ts`.
- Google Tasks are parked.
- Run updates show task progress and the final branch and commit count.

## Calls made in this document, for the owner to check

- Only the token owner may command by default; `--allow` adds others by
  user id, not email, so login needs the Chat message scopes only.
- Each decision runs as a small read-only `chief` flow, so it is traced
  and costed like any run.
- The Chief's seat is the reasoner CLI, toolless, never a roster seat,
  and must enforce read-only; otherwise the verb refuses to start.
- Before each writing run the loop returns to the branch it started on,
  and refuses when the tree is dirty.
- Replies carry a marker and are also recognised by message name.
- The Chief decides one typed action per request; code
  acts through the run supervisor.
- Run updates are written by code from the trace, the plan's task
  checkboxes and git, throttled to one per 30 seconds per run, with no
  model call.
- Allowed flows default to `implement` only; a flow that can pause is
  started with `--no-pause`.
- Stopping `llm4ts chat` stops the runs it started.
- No push and no pull request from chat in the PoC.
- A fresh state starts from now and does not replay the space's history.
- `--observe` mode exists and is the recommended first run.
- "assign to…" is declined in words until tasks return.

## Left to the builder

- The exact `gws` version range, after the first open check.
- How the loop hands the request and context to the `chief` flow (a file
  path as the task argument is the obvious way).
- The wording of prompts and fixed replies.
- Whether the run-update fiber reads the trace through the operator's
  `run_wait` handler or through the reader beneath it. `runDiagnosisOf`
  (`RunReaders.ts`) is callable without the MCP layer.
- The file split inside `shell` if `ChatLoop` grows past one module.
