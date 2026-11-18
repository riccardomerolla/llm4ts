# A Chief of Staff in Google Chat

`llm4ts chat` binds one repository to one Google Chat space until you stop
it. Anyone you allow types `/bot …` in the space; a Chief of Staff answers
questions about the repository's runs, starts a flow, or stops a run, and
the progress of every run it started is posted back into the request's
thread. Design and decisions: [ADR 0052](adr/0052-google-chat-chief.md).

```text
Riccardo   /bot what is running?
Riccardo   🌙 chief: Nothing is running. The last run, implement
           (op-…-3fa2), finished green 40 minutes ago: 3 tasks, $0.82.
Riccardo   /bot implement a CSV export on the orders page
Riccardo   🌙 chief: Starting implement for the CSV export. I will
           post progress here. (run op-…-9c1e)
Riccardo   🌙 chief: op-…-9c1e: plan written, 4 tasks
Riccardo   🌙 chief: op-…-9c1e completed in 11 min, $1.37.
           Branch llm4ts/csv-export, 4 commits.
```

It runs on what one person can set up alone: a personal Google Workspace
login, no bot account, nothing an admin installs.

> **Not yet checked in a real space.** The verb has been driven end to end
> with a stand-in `gws` and a stand-in coding agent (the `verify-llm4ts`
> skill's [chat recipe](../.claude/skills/verify-llm4ts/features/chat.md)),
> never against a real Workspace space. Two things only a real space can
> show are still open: the exact JSON `gws` prints for real messages, and
> whether a typed `/bot hello` reaches the space as plain text (if Chat
> takes it as a slash command, use `--trigger @bot` or `--trigger bot:`).

## Setup

1. **Install `gws`**, the Google Workspace CLI (`@googleworkspace/cli`),
   and put it on your `PATH`. `llm4ts chat` accepts versions from 0.22.5
   up to, not including, 0.23.0, and says so when yours is outside that
   range. `gws` is not an official Google product and is pre-1.0; it does
   the login and keeps and refreshes the token, so llm4ts never sees one.
2. **A Cloud project for the login.** Either let `gws auth setup` create
   it, or by hand: a Google Cloud project with the Google Chat API
   enabled; the Chat app configured in that API's settings with a name
   (Chat shows it beside every line the Chief posts); and an OAuth client
   of type Desktop app. You need a Business or Enterprise Workspace
   account: a consumer Gmail account cannot use the Chat API as a user.
3. **Add yourself as a test user** on the project's OAuth consent screen
   while the app is unpublished.
4. **`gws auth login`** with the Chat message scopes only:
   `chat.messages` (or `chat.messages.readonly` plus
   `chat.messages.create`). llm4ts needs nothing wider; it has no "who am
   I" call, and learns who you are from the line it posts at start.
5. **Find the space id.** Open the space in Chat; the last part of its
   address is the id (`spaces/AAAA…` in the API). `--space` takes either
   form.
6. **Try it in observe mode first**, from the repository:

   ```bash
   llm4ts chat --space spaces/AAAA… --observe
   ```

   It reads the space and decides, but posts nothing and starts nothing:
   it prints each `/bot` sender's user id and what it would reply or
   start. That is also how you collect the ids for `--allow`.

7. **Arm it**: the same command without `--observe`. It posts one line
   saying it is listening, which repository it serves and which flows it
   may start; whoever that line is posted as (you) is the owner. Ctrl-C
   (SIGINT or SIGTERM) stops it, and stops the runs it started; a second
   Ctrl-C exits at once.

The space and the trigger can live in the repository's
`.llm4ts/config.env` (`LLM4TS_CHAT_SPACE`, `LLM4TS_CHAT_TRIGGER`;
[configuration](configuration.md)); a flag wins over a setting.

### Before it starts

It stops, saying why, when `gws` is missing or out of range, when the
space cannot be listed (a lapsed login says to run `gws auth login`), when
the flows cannot be discovered, when there is no `chief` flow, when
`--flows` names a flow that is not there, or when the reasoner CLI cannot
be held read-only. The Chief runs on the reasoner CLI (`LLM4TS_REASONER`,
default `claude`), toolless, and never on a roster seat; the verb refuses
to start unless that CLI's harness enforces read-only, because the request
text comes from people in a chat. It warns, and goes on, when git does not
ignore `.llm4ts/` in the repository.

## Flags

| Flag                | Default                            | Meaning                                                                                           |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--space <space>`   | `LLM4TS_CHAT_SPACE`                | The space, `spaces/AAAA…` or its id. Required.                                                    |
| `--trigger <word>`  | `LLM4TS_CHAT_TRIGGER`, else `/bot` | What a request starts with, as a whole word. `/bot` alone gets a short help reply.                |
| `--allow <users/…>` | nobody                             | A user id who may ask besides you; repeatable. Ids, not emails: an email lookup needs more scope. |
| `--flows <a,b>`     | `implement`                        | The flows the Chief may start. It is shown only these. `chief` is refused.                        |
| `--interval <s>`    | 5                                  | Seconds between looks at the space.                                                               |
| `--marker <text>`   | `🌙 chief:`                        | What every line the Chief posts starts with.                                                      |
| `--observe`         | off                                | Read and decide; post and start nothing; print instead.                                           |

## What the space sees

- **Replies in the request's thread**, each starting with the marker.
  Every line is posted under your name with the app's name beside it, as
  plain text: a message created with a user login cannot be a card.
- **Who may ask.** Only you, and the ids you `--allow`. Anyone else who
  types `/bot` gets one reply per process saying who may ask, and nothing
  is decided for them. With no owner known (observe mode on a fresh
  state), nobody may ask. An id you `--allow` can have a coding agent work
  on your machine, in your repository, under your name: allow only people
  you would hand your keyboard.
- **Questions** are answered only from what the Chief was shown: the
  repository's runs, newest first, with their one-line summaries, a
  bounded diagnosis of the newest failed run, and the last few requests.
  When that text does not hold the answer it says so.
- **Starting a run.** One writing run at a time; a second request is
  answered with the running one's id. A dirty working tree is refused in
  words. Before each writing run the loop returns to the base branch: the
  branch checked out when the space's state was first created, kept in
  `state.md` (delete that file to change it). The work stays as commits
  on the flow's branch: no push, no pull request. A flow that can pause for its owner (`roundtable`,
  `taskforce`) is started with `--no-pause`.
- **Progress**, for runs started from chat only: a line when the plan is
  written and as tasks finish (or the story summary for an epic run), at
  most one per run every 30 seconds, and always the ending line with the
  outcome, duration, cost, branch and commit count (the branch is left out
  when the checkout is on the base branch, or the run was lost). No model
  is called for these. The same loop posts them between requests, so none
  appear while a decision is pending (up to 120 seconds).
- **Stopping a run.** The reply says what happened: the run stopped, or
  it was not running.
- **Failures** get a short reply naming the kind of failure; the loop
  goes on. When the Chief cannot decide, the terminal says why, with the
  chief run's id and where its logs are. A file under `.llm4ts/chat/` that
  cannot be read or written is told to the terminal, and the loop goes on.
  A failed look at the space backs off and retries.

Each decision is a small read-only `chief` flow run, so it has a trace and
shows in `llm4ts costs`; it is left out of the runs the Chief reports on.

## State

Under `<repo>/.llm4ts/chat/<space-id>/`: `state.md` (the cursor, the names
of the lines the Chief posted, the owner's id, the base branch),
`requests.md` (one section per request: text, action, reply, run id,
outcome), `pending/` (each request's context for the `chief` flow) and
`actions/` (each decision). `pending/` and `actions/` are kept, never
cleaned up, and hold the request text. A restart continues from the
cursor; a fresh state starts at the moment it starts, so old `/bot` messages are not replayed. The run
registry is the one `llm4ts mcp` uses
(`~/.local/state/llm4ts/mcp/<repo>/`), so the Chief sees, and may stop,
runs an MCP client started in the same repository.

## Limits of a personal login

- Every line, yours and the Chief's, shows your name; only the marker and
  the app's name tell them apart.
- No cards, buttons or slash-command registration: text only.
- The process polls; there is no push delivery.
- Google Tasks are not used: the API cannot create a task in a space's
  Tasks tab. "Assign to…" is declined in words.
- One process binds one repository to one space.
