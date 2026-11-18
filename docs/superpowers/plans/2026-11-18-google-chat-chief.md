# Google Chat Chief of Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `llm4ts chat --space <space>` binds a repository to a Google Chat
space: a Chief of Staff answers `/bot` messages, starts and stops flows,
and posts run progress.

**Architecture:** A `GoogleChatTool` in `flow` wraps the `gws` CLI the way
`GitHubTool` wraps `gh`. A `ChatLoop` in `shell` polls the space, owns a
`RunSupervisor`, and asks a small read-only `chief` flow for one typed
`ChiefAction` per request. Code acts on the action and writes run updates
from the trace, the plan's checkboxes and git.

**Tech Stack:** TypeScript, Effect 4.1.4, `@effect/vitest`, the `gws` CLI
(`@googleworkspace/cli`) at runtime only.

**Spec:** `docs/superpowers/specs/2026-11-18-google-chat-chief-design.md`.
Read it before any task.

## Global Constraints

- Effect 4 services and layers; schemas at external and persistence
  boundaries; expected failures are `Schema.TaggedError`.
- No `any`, no unchecked assertions, no global `Error` as a domain error.
- Relative imports carry `.ts`; cross-package imports use subpath exports.
- No token, client secret or credentials path in arguments, logs, traces,
  state files or error messages. llm4ts passes no credentials to `gws`.
- Tests use `@effect/vitest` and the in-src fakes; no network, no `gws`,
  no Google credentials.
- Default trigger `/bot`. Default reply marker `🌙 chief:`. Default
  interval 5 seconds. Default allowed flows `implement`. Run-update
  throttle 30 seconds per run. Posted-names bound 500. Reply cap 4000
  characters.
- State lives under `<repo>/.llm4ts/chat/<space-id>/`.
- Work on branch `google-chat-chief`. The first commit adds the design
  doc and this plan.
- Every task ends green on `pnpm typecheck && pnpm lint && pnpm
format:check && pnpm unused && pnpm test`. A new module with no
  production importer yet is listed in `scripts/unused-modules.mjs` with
  the reason "wired by the chat verb (plan task 8)" and removed from that
  list in task 8. Run `pnpm exports:write` after adding a module.

## Review Focus

1. A message that is only the trigger, or the trigger glued to a word
   (`/bots are great`). Expected: the first gets a short help reply with
   no seat call; the second is ignored. Test in task 6.
2. Two `/bot implement…` requests in one beat. Expected: one run starts;
   the second gets a reply naming the running one. Test in task 6.
3. A request whose task text starts with `-` or `@`. Expected: a reply in
   words, no crash, no run. Test in task 6.
4. A message from an app or with no sender, or with empty text.
   Expected: ignored, cursor still advances. Test in task 6.
5. The `gws` login expires while the loop runs. Expected: the loop ends
   with one line telling the owner to run `gws auth login`, and the
   supervisor's scope stops the runs. Test in task 6.

---

### Task 0: Confirm what `gws` and Chat actually do

This task needs the owner: the OAuth login is theirs. No product code.

**Files:**

- Create: `packages/flow/test/fixtures/gws/messages-list.json`,
  `messages-create.json`, `auth-error.json`, `version.txt`

- [ ] **Step 1:** Ask the owner to install `gws`
      (`npm install -g @googleworkspace/cli`), create the Cloud project and
      Desktop OAuth client, and run `gws auth login` with the scopes
      `chat.messages` only. Do not handle the credentials yourself.
- [ ] **Step 2:** Run `gws --version` and
      `gws chat spaces messages list --help`. Record the version.
- [ ] **Step 3:** In a test space, run a list with
      `--params '{"parent":"spaces/<id>","filter":"createTime > \"<ts>\"","orderBy":"createTime ASC","pageSize":100}'`
      and confirm the filter and order are honoured. Run a create with a
      thread and `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.
      Run a list with a bad credentials file to capture the login failure.
- [ ] **Step 4:** Type `/bot hello` in the space and list again. Confirm
      it arrives as text `/bot hello`.
- [ ] **Step 5:** Save the four outputs as fixtures with ids and names
      replaced by placeholders (`spaces/SPACE1`, `users/USER1`, no display
      names of real people).
- [ ] **Step 6: Gate.** Stop and return to the owner when `list` is
      missing, when the filter is ignored, or when `/bot` does not arrive as
      text. The spec names the fallbacks; choosing one is the owner's call.
- [ ] **Step 7:** Commit the fixtures.

### Task 1: `GoogleChatTool`

**Files:**

- Create: `packages/flow/src/GoogleChatTool.ts`
- Test: `packages/flow/test/GoogleChatTool.test.ts`

**Interfaces:**

- Consumes: `ProcessExecutorShape`, `FlowEventsShape`, `ProcessError`,
  `guarded` as `GitHubTool.ts` uses them; the task 0 fixtures.
- Produces:

```ts
export class SpaceRef extends Schema.Class<SpaceRef>("SpaceRef")({ id: Schema.String }) {
  get name(): string // "spaces/<id>"
}
export const parseSpaceRef: (input: string) => SpaceRef | undefined // "spaces/X" or "X"
export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  name: Schema.String, // "spaces/X/messages/Y"
  createTime: Schema.String,
  text: Schema.String, // "" when the message has none
  senderName: Schema.optional(Schema.String), // "users/…"
  senderType: Schema.optional(Schema.String), // "HUMAN" | "BOT"
  senderDisplayName: Schema.optional(Schema.String),
  threadName: Schema.optional(Schema.String)
}) {}
export class GwsLoginRequired extends Schema.TaggedError<GwsLoginRequired>()("GwsLoginRequired", {
  message: Schema.String
}) {}
export const gwsVersionRange: { readonly min: string; readonly below: string }
export const messagesListArgs: (
  space: SpaceRef,
  after: string,
  pageToken?: string
) => ReadonlyArray<string>
export const messageCreateArgs: (
  space: SpaceRef,
  text: string,
  threadName?: string
) => ReadonlyArray<string>
export const parseMessages: (
  json: string
) => Effect.Effect<
  { readonly messages: ReadonlyArray<ChatMessage>; readonly nextPageToken: string | undefined },
  ProcessError
>
export const parseMessage: (json: string) => Effect.Effect<ChatMessage, ProcessError>
export const checkGwsVersion: (stdout: string) => Effect.Effect<void, ProcessError>
export interface GoogleChatToolShape {
  readonly probe: Effect.Effect<void, FlowError>
  readonly listMessages: (
    space: SpaceRef,
    after: string
  ) => Effect.Effect<ReadonlyArray<ChatMessage>, FlowError | GwsLoginRequired>
  readonly createMessage: (
    space: SpaceRef,
    text: string,
    threadName?: string
  ) => Effect.Effect<ChatMessage, FlowError | GwsLoginRequired>
}
export const makeGoogleChatTool: (
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape
) => GoogleChatToolShape
```

- [ ] **Step 1: Failing tests.** Against the fixtures and a fake
      executor:
  - `messagesListArgs` yields `chat spaces messages list` with `parent`,
    `filter` `createTime > "<after>"`, `orderBy` `createTime ASC`,
    `pageSize` 100, and `pageToken` only when given.
  - `messageCreateArgs` with a thread sets `thread.name` and
    `messageReplyOption` `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`; without
    one it sets neither.
  - `parseMessages` decodes the list fixture; a message with no `text`
    decodes to `""`; malformed JSON is a `ProcessError`.
  - `listMessages` follows `nextPageToken` over two fake pages and
    returns oldest first.
  - The auth-error fixture maps to `GwsLoginRequired` whose message holds
    no path and no token.
  - `checkGwsVersion` accepts the recorded version and refuses one below
    `min` and one at `below`, naming the range.
  - `parseSpaceRef` accepts `spaces/AAA` and `AAA`, refuses `a b` and
    `spaces/`.
- [ ] **Step 2:** Run `pnpm vitest run packages/flow/test/GoogleChatTool.test.ts`; expect failures on missing exports.
- [ ] **Step 3:** Implement, following `makeGitHubTool`'s `run` helper.
      `gwsVersionRange.min` is the task 0 version; `below` is the next minor.
- [ ] **Step 4:** Run the test file; expect pass. Run the chain.
- [ ] **Step 5:** Commit `GoogleChatTool: list and create Chat messages through gws`.

### Task 2: `ChiefAction`

**Files:**

- Create: `packages/flow/src/ChiefAction.ts`
- Test: `packages/flow/test/ChiefAction.test.ts`

**Interfaces:**

- Produces:

```ts
export const maxReplyChars = 4000
export class ChiefContext extends Schema.Class<ChiefContext>("ChiefContext")({
  messageName: Schema.String,
  actionPath: Schema.String, // where the chief flow writes its ChiefAction
  request: Schema.Struct({ text: Schema.String, sender: Schema.String }),
  flows: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  runs: Schema.Array(Schema.Struct({
    runId: Schema.String, flow: Schema.String, state: Schema.String, summary: Schema.String })),
  diagnosis: Schema.optional(Schema.String),
  recent: Schema.Array(Schema.String)
}) {}
export class ChiefProposal extends Schema.Class<ChiefProposal>("ChiefProposal")({
  action: Schema.Literals(["answer", "start_run", "stop_run", "decline"]),
  reply: Schema.String,
  flow: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String)
}) {}
export const chiefProposalJsonSchema: JsonSchema
export const ChiefAction: Schema.Union<…> // tagged: Answer{reply} | StartRun{flow,task,reply}
                                          // | StopRun{runId,reply} | Decline{reply} | Failed{reply}
export type ChiefAction = typeof ChiefAction.Type
export const failedReply = "I could not work that out. Try rephrasing the request."
export const validateChiefProposal: (
  proposal: ChiefProposal, context: ChiefContext
) => { readonly _tag: "Valid"; readonly action: ChiefAction }
   | { readonly _tag: "Invalid"; readonly violations: ReadonlyArray<string> }
export const chiefPrompt: (context: ChiefContext, violations: ReadonlyArray<string>) => string
```

`Failed` is the one addition to the spec's four variants: it carries the
fixed reply after two invalid proposals, so the loop can log the request
as failed.

- [ ] **Step 1: Failing tests.**
  - `start_run` with a flow not in `context.flows` → violation naming the
    flow; with no `task` → violation.
  - `stop_run` with a `runId` not in `context.runs` → violation.
  - empty or whitespace `reply` → violation; a reply over `maxReplyChars`
    → violation.
  - each valid proposal maps to its tagged variant with trimmed fields.
  - `chiefPrompt` contains every allowed flow name, every run summary and
    the request text; with violations it lists them; it tells the model
    to answer only from the given text.
  - `ChiefContext` and `ChiefAction` round-trip through JSON.
- [ ] **Step 2:** Run the test file; expect failures.
- [ ] **Step 3:** Implement. Pure module, no Effect services.
- [ ] **Step 4:** Run; expect pass. Run the chain.
- [ ] **Step 5:** Commit `ChiefAction: the Chief's typed decision`.

### Task 3: the `chief` flow

**Files:**

- Create: `flows/chief.ts`, `flows/lib/chief.ts`
- Modify: `packages/shell/src/RunSupervisor.ts:125` (default
  `readOnlyFlows` becomes `epic-retro` and `chief`)
- Modify: `packages/runner/src/Connectors.ts` (add `readOnlySeatProblem`)
- Test: `flows/test/chief.test.ts`, `packages/shell/test/RunSupervisor.test.ts`,
  `packages/runner/test/Connectors.test.ts`

**Interfaces:**

- Consumes: task 2; `structuredAndPublish` (`@llm4ts/flow/Usage`);
  `asToolless`, `reasonerFromEnvironment` (`@llm4ts/runner/Connectors`);
  `runNode`, `runFlowMain`, `resolveFlowInput` as `flows/epic-retro.ts`.
- Produces:

```ts
// flows/lib/chief.ts
export const loadChiefContext: (
  files: PlainFileStoreShape,
  task: string
) => Effect.Effect<ChiefContext, ScriptUsage> // task is a path to the JSON context
export const runChief: (deps: {
  readonly files: PlainFileStoreShape
  readonly events: FlowEventsShape
  readonly seat: LlmServiceShape
  readonly context: ChiefContext
}) => Effect.Effect<ChiefAction, PersistenceError> // also writes context.actionPath
// packages/runner/src/Connectors.ts
export const readOnlySeatProblem: (config: CliConnectorConfig) => string | undefined
```

`flows/chief.ts` takes the context file path as its task. It resolves the
reasoning seat as `epic-retro.ts` does, wraps it with `asToolless`, and
fails with `ScriptUsage` carrying `readOnlySeatProblem`'s sentence when
there is one. `readOnlySeatProblem` returns `undefined` for a connector
whose `capabilities.readOnlyEnforcement` is `"enforced"` and a sentence
naming the connector and its grade otherwise; use the capability lookup
at `packages/runner/src/FlowRunner.ts:440-465`.

This is stricter than the spec, which lets a read-only CLI seat read the
repository: `asToolless` exists, so the Chief gets no tools on any seat,
and the enforced grade is still required because a harness that only
advises read-only may ignore the toolless request too.

`runChief` calls `structuredAndPublish(seat, events, chiefPrompt(context,
violations), ChiefProposal, chiefProposalJsonSchema, "chief")`, validates,
retries once with the violations, and on a second invalid proposal or a
seat failure yields `Failed{reply: failedReply}`. It writes the action as
JSON to `context.actionPath` with `writeAtomic` in every case.

- [ ] **Step 1: Failing tests.** With a fake seat and
      `makeMemoryPlainFileStore`:
  - a valid proposal is written to `actionPath` and returned;
  - an invalid then a valid proposal makes two seat calls, the second
    prompt holding the violation;
  - two invalid proposals write `Failed` with `failedReply`;
  - a seat error writes `Failed`;
  - `loadChiefContext` fails with `ScriptUsage` on a missing file and on
    JSON that is not a `ChiefContext`.
  - `readOnlySeatProblem`: `undefined` for an enforced connector, a
    sentence for an advisory one.
  - Supervisor: a `chief` run starts while a writing run is active.
- [ ] **Step 2:** Run the three test files; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect pass. Run the chain, then
      `pnpm build && node scripts/pack-smoke.mjs` since a bundled flow was
      added.
- [ ] **Step 5:** Commit `chief flow: one typed decision per request`.

### Task 4: progress sentences for plain runs

**Files:**

- Modify: `packages/runner/src/RunSummary.ts`
- Modify: `packages/flow/src/GitTool.ts` (add `commitsAhead`)
- Test: `packages/runner/test/RunSummary.test.ts`,
  `packages/flow/test/GitTool.test.ts`

**Interfaces:**

- Produces:

```ts
export interface PlainProgress {
  readonly tasksTotal: number
  readonly tasksDone: number
  readonly ended?: {
    readonly outcome: string // the trace's RunEnded outcome
    readonly minutes: number
    readonly costUsd: number
    readonly branch?: string
    readonly commits?: number
  }
}
export const plainProgressLine: (
  runId: string, previous: PlainProgress | undefined, next: PlainProgress) => string | undefined
// GitToolShape gains:
readonly commitsAhead: (base: string) => Effect.Effect<number, FlowError> // git rev-list --count <base>..HEAD
```

- [ ] **Step 1: Failing tests** with these exact strings, `runId`
      `op-1-ab12`:
  - previous `undefined`, next 4 tasks 0 done → `op-1-ab12: plan written, 4 tasks`
  - previous 4/1, next 4/2 → `op-1-ab12: task 2 of 4 done`
  - previous equal to next → `undefined`
  - next 0 tasks, not ended → `undefined`
  - ended `completed`, 11 minutes, 1.37, branch `llm4ts/csv-export`, 4
    commits → `op-1-ab12 finished completed in 11 min, $1.37. Branch llm4ts/csv-export, 4 commits.`
  - ended with no branch → the same line without the branch sentence
  - ended wins over a task change in the same step
  - `commitsAhead("main")` runs `git rev-list --count main..HEAD` and
    parses the number; non-numeric output is a `ProcessError`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement as a pure function beside `summarizeTree`.
- [ ] **Step 4:** Run; expect pass. Run the chain.
- [ ] **Step 5:** Commit `Progress line for runs with tasks and no stories`.

### Task 5: `ChatState`

**Files:**

- Create: `packages/shell/src/ChatState.ts`
- Test: `packages/shell/test/ChatState.test.ts`

**Interfaces:**

- Consumes: `PlainFileStoreShape`; `SpaceRef` from task 1.
- Produces:

```ts
export const postedLimit = 500
export const chatDir: (repoPath: string, space: SpaceRef) => string // <repo>/.llm4ts/chat/<space.id>
export class ChatState extends Schema.Class<ChatState>("ChatState")({
  space: Schema.String,
  trigger: Schema.String,
  marker: Schema.String,
  cursor: Schema.String, // RFC 3339
  posted: Schema.Array(Schema.String), // message names, newest last
  ownerId: Schema.optional(Schema.String),
  baseBranch: Schema.String
}) {}
export class ChatRequest extends Schema.Class<ChatRequest>("ChatRequest")({
  messageName: Schema.String,
  createTime: Schema.String,
  sender: Schema.String,
  text: Schema.String,
  threadName: Schema.optional(Schema.String),
  status: Schema.Literals(["received", "answered", "started", "refused", "failed", "ended"]),
  action: Schema.optional(Schema.String),
  reply: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String)
}) {}
export const renderState: (state: ChatState) => string
export const parseState: (markdown: string) => Effect.Effect<ChatState, PersistenceError>
export const loadState: (
  files: PlainFileStoreShape,
  dir: string
) => Effect.Effect<ChatState | undefined, PersistenceError>
export const saveState: (
  files: PlainFileStoreShape,
  dir: string,
  state: ChatState
) => Effect.Effect<void, PersistenceError>
export const notePosted: (state: ChatState, messageName: string) => ChatState // bounded to postedLimit
export const loadRequests: (
  files: PlainFileStoreShape,
  dir: string
) => Effect.Effect<ReadonlyArray<ChatRequest>, PersistenceError>
export const putRequest: (
  files: PlainFileStoreShape,
  dir: string,
  request: ChatRequest
) => Effect.Effect<void, PersistenceError> // insert, or replace by messageName; never removes
```

`state.md` and `requests.md` are markdown: a readable body and the typed
data in a fenced `json` block per item, decoded through the schemas. The
file is rewritten atomically; "append-only" in the spec means a request
section is never removed.

- [ ] **Step 1: Failing tests.** State round trip; `loadState` on a
      missing file is `undefined`; a corrupt file is a `PersistenceError`
      naming the path; `notePosted` keeps the newest 500 of 501;
      `putRequest` twice with one `messageName` leaves one section with the
      later fields; request text containing a fenced block and `###`
      survives a round trip.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect pass. Run the chain.
- [ ] **Step 5:** Commit `ChatState: the chat's markdown state`.

### Task 6: `ChatLoop`, requests

**Files:**

- Create: `packages/shell/src/ChatLoop.ts`
- Test: `packages/shell/test/ChatLoop.test.ts`,
  `packages/shell/test/support/FakeChat.ts`

**Interfaces:**

- Consumes: tasks 1, 2, 5; `RunSupervisorShape`, `StartRun`
  (`RunSupervisor.ts`); `validateKnobs` (`OperatorActTools.ts`);
  `foldTrace`, `runStatusOf`, `runDiagnosisOf`, `RunSources`
  (`RunReaders.ts`); `discoveredRuns`, `resolveRun` (`OperatorRuns.ts`);
  `GitToolShape` (`currentBranch`, `uncommittedFiles`, `checkout`).
- Produces:

```ts
export interface ChatOptions {
  readonly space: SpaceRef
  readonly trigger: string
  readonly marker: string
  readonly allow: ReadonlyArray<string> // "users/…"
  readonly flows: ReadonlyArray<string>
  readonly intervalSeconds: number
  readonly observe: boolean
}
export interface ChatLoopDeps {
  readonly chat: GoogleChatToolShape
  readonly files: PlainFileStoreShape
  readonly supervisor: RunSupervisorShape
  readonly git: GitToolShape
  readonly repo: SupervisorRepo
  readonly flows: Effect.Effect<ReadonlyArray<{ name: string; path: string; description: string }>>
  readonly sources: RunSources
  readonly decide: (context: ChiefContext) => Effect.Effect<ChiefAction>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly now: Effect.Effect<number>
  readonly say: (line: string) => Effect.Effect<void> // the verb's terminal
  readonly options: ChatOptions
}
export type Selected =
  | { readonly _tag: "Request"; readonly message: ChatMessage; readonly body: string }
  | { readonly _tag: "Help"; readonly message: ChatMessage }
  | { readonly _tag: "Stranger"; readonly message: ChatMessage }
export const selectRequests: (
  state: ChatState,
  messages: ReadonlyArray<ChatMessage>,
  options: ChatOptions
) => { readonly selected: ReadonlyArray<Selected>; readonly cursor: string }
export const helpReply: (options: ChatOptions) => string
export const strangerReply: string
export const handleBeat: (
  deps: ChatLoopDeps,
  state: ChatState
) => Effect.Effect<ChatState, GwsLoginRequired | PersistenceError>
export const decideThroughFlow: (
  deps: Omit<ChatLoopDeps, "decide">
) => (context: ChiefContext) => Effect.Effect<ChiefAction>
```

`selectRequests` is pure. A message is dropped when its `name` is in
`state.posted`, its text starts with `state.marker`, its `senderType` is
not `HUMAN`, it has no `senderName`, or its text is empty. The trigger
matches only when followed by whitespace or the end of the text. A sender
is allowed when equal to `state.ownerId` or in `options.allow`; with no
`ownerId` nobody is allowed. The cursor is the greatest `createTime`
seen, or the old cursor when there were no messages.

`handleBeat` lists, selects, and for each selection in order:

- `Help` → post `helpReply` in the thread.
- `Stranger` → post `strangerReply` once per sender per process.
- `Request` → `putRequest` as `received`; build the `ChiefContext`
  (allowed flows filtered from `deps.flows`; runs from the supervisor and
  `discoveredRuns`, without `chief` runs, each summarised; the diagnosis
  of the newest failed run; the last 5 request lines); `deps.decide`;
  act; reply; `putRequest` with the result.

Acting on `StartRun`: `validateKnobs`; refuse in words when
`git.uncommittedFiles` is non-empty; `git.checkout(state.baseBranch)`;
`supervisor.start` with `requestId` the message `name` and `--no-pause`
only for `roundtable` and `taskforce`. `RunInProgress` becomes a reply
naming the running id. `StopRun` calls `supervisor.stop`. Every posted
message is prefixed with the marker and a space, cut to `maxReplyChars`,
and recorded with `notePosted`. Under `observe`, nothing is posted or
started: each would-be reply and action goes to `deps.say`, as does each
`/bot` sender's id and display name.

A failure while handling one request posts `<marker> That failed: <kind>`
where `<kind>` is the error's `_tag`, marks the request `failed`, and the
beat goes on. `GwsLoginRequired` is not caught.

`decideThroughFlow` writes the context to
`<chatDir>/pending/<message-id>.json` with `actionPath`
`<chatDir>/actions/<message-id>.json`, starts the `chief` flow through
the supervisor with that path as the task, awaits its exit by polling
`supervisor.get` every 500 ms, and decodes the action file. A missing or
undecodable file, or a non-zero exit, yields `Failed{failedReply}`.

- [ ] **Step 1: Failing tests** with `FakeChat` (an in-memory space with
      `listMessages`/`createMessage` and a `failWith` switch), a scripted
      `decide`, and the supervisor over its fake process:
  - own messages are ignored by name, and by marker after `posted` is
    emptied;
  - `/bot` alone → `Help`, no `decide` call; `/bots are great` → ignored;
  - a stranger gets `strangerReply` once across three messages and no
    `decide` call; an `--allow`ed sender is handled;
  - app messages, senderless messages and empty text are ignored and the
    cursor passes them;
  - `Answer` posts `🌙 chief: <reply>` in the request's thread;
  - `StartRun` starts one run with `requestId` equal to the message
    name; a second in the same beat is answered with the running id;
  - `StartRun` with task `-rf` or `@x` replies in words and starts
    nothing;
  - `StartRun` on a dirty tree replies in words and starts nothing;
  - `StartRun` checks out `baseBranch` first;
  - `implement` gets no `--no-pause`; `taskforce` gets it;
  - a `decide` defect posts the failure line and the next request in the
    beat is still handled;
  - a restart from saved state does not replay handled messages;
  - `observe`: nothing posted, nothing started, lines sent to `say`;
  - `GwsLoginRequired` from `listMessages` fails `handleBeat`;
  - `decideThroughFlow`: a written action file is returned; a missing
    file after exit is `Failed`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect pass. Run the chain.
- [ ] **Step 5:** Commit `ChatLoop: handle /bot requests`.

### Task 7: `ChatLoop`, run updates and the loop itself

**Files:**

- Modify: `packages/shell/src/ChatLoop.ts`
- Test: `packages/shell/test/ChatLoop.test.ts`

**Interfaces:**

- Consumes: task 4 (`plainProgressLine`, `commitsAhead`); task 6;
  `meaningfulEventsAfter`, `foldTrace` (`RunReaders.ts`); `summarizeTree`;
  `parsePlan` and `defaultPlanPath` as `OperatorTools.ts:540` resolves a
  plain run's plan.
- Produces:

```ts
export const throttleMs = 30_000
export interface Followed {
  readonly runId: string
  readonly seq: number
  readonly progress: PlainProgress | undefined
  readonly lastPostedAt: number
  readonly done: boolean
}
export const followRun: (
  deps: ChatLoopDeps,
  state: ChatState,
  followed: Followed
) => Effect.Effect<
  { readonly followed: Followed; readonly state: ChatState },
  GwsLoginRequired | PersistenceError
>
export class ChatStopped extends Schema.TaggedError<ChatStopped>()("ChatStopped", {
  message: Schema.String
}) {}
export const startChat: (
  deps: ChatLoopDeps
) => Effect.Effect<ChatState, ChatStopped | PersistenceError>
export const runChat: (deps: ChatLoopDeps) => Effect.Effect<never, ChatStopped | PersistenceError>
```

`followRun` handles one run started from chat (a request with a `runId`
and status `started`). For a run whose trace fold has stories it posts
`<runId>: <summarizeTree>` when `meaningfulEventsAfter(seq)` is
non-empty. Otherwise it builds a `PlainProgress` from the plan's
checkboxes and posts `plainProgressLine` when it is defined. It posts at
most once per `throttleMs` per run, except the ending line, which is
always posted, into the request's thread. At the end it reads
`git.currentBranch` and `git.commitsAhead(state.baseBranch)`, and
`putRequest`s the request as `ended` with the outcome.

`startChat` runs the start checks: `chat.probe`; one `listMessages` from
now; the seat check (`readOnlySeatProblem` on the reasoning seat). A
failure is `ChatStopped` with a plain sentence. It loads or creates the
state (new state: cursor now, `baseBranch` the current branch), warns
through `say` when `.llm4ts/` is not ignored by the repository, and
unless `observe` posts `<marker> Listening. Repository <repo id>. I may
start: <flows>.` and stores that message's `senderName` as `ownerId`.

`runChat` is `startChat`, then forever: `handleBeat`, `followRun` for
each started request, `saveState`, sleep `intervalSeconds`. A `FlowError`
from `listMessages` is retried with exponential backoff from 1 second
capped at 60 seconds and never ends the loop. `GwsLoginRequired` becomes
`ChatStopped` with `Google login expired. Run: gws auth login`.

- [ ] **Step 1: Failing tests**, with `TestClock`:
  - a plain run posts `plan written, 4 tasks`, then after two task
    completions inside 30 seconds posts one line, `task 3 of 4 done`,
    once the window passes;
  - the ending line is posted inside the throttle window and holds the
    branch and commit count;
  - a story-shaped run posts `summarizeTree`'s sentence on a
    `StoryStatusChanged`;
  - a run not started from chat is never announced;
  - updates go to the starting request's thread, also after a restart;
  - `startChat` stores `ownerId` from the listening line; under
    `observe` it posts nothing and leaves `ownerId` unset;
  - `startChat` fails with `ChatStopped` when the probe fails and when
    the seat is advisory;
  - a new state's cursor is now: an older `/bot` message is not handled;
  - `runChat` survives two failed lists and handles the third;
  - `runChat` ends with `ChatStopped` on `GwsLoginRequired`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect pass. Run the chain.
- [ ] **Step 5:** Commit `ChatLoop: run updates and the loop`.

### Task 8: the `chat` verb, settings, docs, ADR

**Files:**

- Modify: `packages/shell/src/Cli.ts` (a `chatCommand` beside
  `mcpCommand`, added to the subcommand list at `:1244`)
- Create: `packages/shell/src/ChatNode.ts` (the Node wiring)
- Modify: `packages/core/src/settings/` (two settings; follow a
  neighbouring string setting)
- Modify: `scripts/unused-modules.mjs` (remove this plan's entries)
- Create: `docs/google-chat.md`, `docs/adr/00NN-google-chat-chief.md`
  (the next free number)
- Modify: `README.md`, `docs/api.md`, `docs/architecture.md`,
  `CHANGELOG.md` (an unreleased entry; no version bump)
- Test: `packages/shell/test/Cli.test.ts`, `packages/shell/test/ChatNode.test.ts`

**Interfaces:**

- Consumes: tasks 1 to 7; `makeRunSupervisor`, `nodeFlowProcess`,
  `nodePlainFileStore`, `nodeListFiles`, `discoverFlows`,
  `shellTierPaths` as `nodeOperatorRuntime` (`OperatorNode.ts:124`) wires
  them; the settings registry (ADR 0049).
- Produces:

```ts
export interface ChatFlags {
  readonly space: Option.Option<string>
  readonly trigger: Option.Option<string>
  readonly marker: Option.Option<string>
  readonly allow: ReadonlyArray<string>
  readonly flows: Option.Option<string> // comma-separated
  readonly interval: Option.Option<number>
  readonly observe: boolean
}
export const chatOptionsFrom: (
  flags: ChatFlags,
  environment: Readonly<Record<string, string | undefined>>
) => Effect.Effect<ChatOptions, ScriptUsage>
export const nodeChatDeps: (
  options: ChatOptions,
  cwd: string
) => Effect.Effect<ChatLoopDeps, ServeError, Scope.Scope>
```

Settings: `LLM4TS_CHAT_SPACE` and `LLM4TS_CHAT_TRIGGER`. A flag wins over
the setting. `chatOptionsFrom` fails with `ScriptUsage` when no space is
given, when the space does not parse, when an `--allow` value does not
start with `users/`, when the interval is under 1, and when `--flows` is
empty.

The command's description: `Bind this repository to a Google Chat space:
a Chief of Staff answers /bot, starts flows and posts progress`. SIGINT
and SIGTERM interrupt `runChat`; the supervisor's scope then stops the
runs, as for `llm4ts mcp`.

`docs/google-chat.md` covers setup in the order of the spec's Setup
section, the flags, what the space sees, and the limits of a personal
token. The ADR records the decisions in the spec's "Decisions the owner
made" and "Calls made in this document".

- [ ] **Step 1: Failing tests.** `chatOptionsFrom`: defaults (`/bot`,
      `🌙 chief:`, 5, `implement`); the setting supplies the space; the flag
      beats the setting; each refusal above. `Cli.test.ts`: `chat` is listed
      in help with its description.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement the verb and wiring; write the docs and ADR;
      run `pnpm exports:write`.
- [ ] **Step 4:** Run the chain and `pnpm build && node
scripts/pack-smoke.mjs`.
- [ ] **Step 5: Live check, with the owner.** In a scratch repository
      with a stub coder (the `verify-llm4ts` skill shows how), run `llm4ts
chat --space <id> --observe`, type `/bot what is running?`, and confirm
      the would-be reply prints. Then run without `--observe`, ask the same,
      and ask `/bot implement add a hello file`. Capture the space's thread
      as the proof. Report what could not be checked.
- [ ] **Step 6:** Commit `llm4ts chat: a Chief of Staff in Google Chat`.
