# ADR 0052: `llm4ts chat` — a Chief of Staff in Google Chat

Status: Accepted (4.9.0) · Date: 2026-11-18 · Extends ADR 0017, ADR 0041, ADR 0049

## Context

A prospect runs everything on Google and wants to watch llm4ts work from a
Google Chat space: a Chief of Staff that posts progress on runs, answers
questions about them, and starts work when asked ("implement a new
feature…"). The reference is the evening a Grok Bot drove llm4ts from a
chat (ADR 0041), with Google Chat as the chat.

The proof of concept has to work with what one person can set up alone: a
personal Workspace login, no agent account, no bot an admin installs. With
a user login Google's Chat API lists and creates messages (text only, the
user shown as sender, the app's name beside it); it cannot post cards, and
it cannot create a task in a space's Tasks tab. A consumer Gmail account
cannot use it at all.

The design is `docs/superpowers/specs/2026-11-18-google-chat-chief-design.md`;
the user guide is [google-chat.md](../google-chat.md).

## Decision

Decisions the owner made:

- **A new verb, `llm4ts chat --space <space>`**, run in a repository,
  binds that repository to one space until stopped. Not a front door to
  Nightcall (it would need GitHub and keep state in labels), and not a
  third-party chat agent in front of `llm4ts mcp` (nothing would own the
  loop). One process, one repository, one space.
- **Transport: wrap the `gws` CLI** (`@googleworkspace/cli`), which does
  the OAuth login and keeps and refreshes the token. llm4ts passes it no
  credential and reads none. `gws` is pre-1.0 and not a Google product, so
  a version probe refuses a version outside the range the tool was written
  against (0.22.5 up to 0.23.0), and `GoogleChatTool`
  (`packages/flow/src/GoogleChatTool.ts`, beside `GitHubTool`) hides it
  behind `listMessages` and `createMessage`, so plain HTTP can replace it.
- **A personal user token**; no agent account.
- **The process polls the space** (default every 5 seconds) and reacts to
  messages that start with a trigger, `/bot` by default.
- **State is markdown in the gitignored `.llm4ts/`**:
  `.llm4ts/chat/<space-id>/state.md` (cursor, posted names, owner, base
  branch) and `requests.md` (one section per request), each with a typed
  header read through a schema. A restart continues from the cursor.
- **Google Tasks are parked.** "Assign to…" is declined in words.
- **Run updates show task progress and the end**: the plan's task count,
  tasks done, and at the end the outcome, duration, cost, branch and
  commits over the base branch.

Calls made in the design, which the owner checks:

- **Only the token owner may command by default.** The owner is the
  sender of the listening line the Chief posts at start. `--allow
users/…` adds others by user id, not email, so the login needs the Chat
  message scopes only. Anyone else gets one reply per process saying who
  may ask. Under `--observe` nothing is posted, so with no stored owner
  nobody may ask; the verb prints each sender's id instead.
- **Each decision is a small read-only bundled flow, `chief`**, started
  through the run supervisor once per request. The loop writes the
  request and its context to a file; the flow makes one structured call
  (ADR 0017: a typed proposal, never parsed prose) and writes the
  validated action. It is traced and costed like any run, and left out of
  the runs the Chief reports on. A decision not made within 120 seconds is
  stopped and answered with a fixed failure reply.
- **The Chief runs on the reasoner CLI (`LLM4TS_REASONER`), toolless,
  and never on a roster seat**; the verb refuses to start unless that
  CLI's harness enforces read-only: the request text comes from people in
  a chat.
- **One typed action per request**: answer, start a run, stop a run, or
  decline. Code validates it (the flow is allowed, the run id is one the
  Chief was shown, the reply fits) and acts through the supervisor.
- **Before each writing run the loop returns to the base branch**, the
  one stored in `state.md` at first start (delete it to change it), and
  refuses in words when the working tree is dirty. One writing run at a
  time; a second request is answered with the running one's id.
- **Replies carry a marker** (`🌙 chief:`) **and are also known by message
  name**: the marker survives a restart, the name set (the last 500)
  survives a changed marker.
- **Run updates are written by code**, from the trace, the plan's task
  checkboxes and git, with no model call: at most one per run per 30
  seconds, and the ending line always. Only runs started from chat are
  announced. The same loop posts them between beats, so none appear while
  a decision is pending (up to 120 seconds).
- **Allowed flows default to `implement`**; a flow that can pause for its
  owner (`roundtable`, `taskforce`) is started with `--no-pause`.
- **Stopping `llm4ts chat` stops the runs it started**, as stopping
  `llm4ts mcp` does (ADR 0041). The supervisor and its registry are the
  operator's, for this one repository; repositories with the same
  directory name share a registry, as under `llm4ts mcp`.
- **No push and no pull request** from chat: the work stays as commits on
  the flow's branch.
- **A fresh state starts from now** and does not replay the space.
- **`--observe` exists and is the recommended first run.**

The space and the trigger are settings (ADR 0049), `LLM4TS_CHAT_SPACE` and
`LLM4TS_CHAT_TRIGGER`, read by the shell only; a flag wins.

## Consequences

- An all-Google team can watch and steer runs from Chat with no GitHub and
  no admin. Every line, the Chief's included, shows the owner's name;
  only the marker and the app's name tell them apart.
- The Chief can be wrong only within what it was shown and what code lets
  it do: at worst a wrong reply, or a start of an allowed flow the sender
  could ask for anyway.
- The Chat tool is reusable: Nightcall can use it later without changes
  here.
- Two checks are owed to a real Workspace space, which the build did not
  have: the JSON `gws` prints for real messages (the parser was written
  from Google's reference and `gws` dry runs), and that a typed `/bot`
  arrives as plain text (if not, the default trigger changes). The verb has
  been driven end to end only against a stand-in `gws`.
- Polling costs one `gws` call per interval while it runs; push delivery
  (Workspace Events) is left for later.
