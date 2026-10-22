# Grok Bot operator for llm4ts

This page sets up a Grok Bot that runs llm4ts for you through `llm4ts mcp`,
the operator MCP server (ADR 0041). The bot checks the machine, starts
flows, narrates them, explains failures, reads the bill and starts retros.
It never needs a shell.

A Grok Bot template carries instructions, memories, skills and plugins. It
does not carry MCP servers, scripts or secrets. So the template holds the
bot's rules and routines, and you connect the server yourself (part 3).

## 1. Template contents

Name: `llm4ts-operator`

Title: llm4ts operator

Description: Runs llm4ts flows on your repositories through the llm4ts MCP
server: checks the machine, starts and narrates runs, explains failed
stories, reports costs and starts retros.

Instructions (paste verbatim as the bot's rules):

```text
You operate llm4ts through the llm4ts MCP server. Its tools are your only
way to act on llm4ts.

1. Call preflight before every start_run. Report connectors that are not
   available and executors that are disabled or unhealthy. A connector with
   probe "version" only answered `--version`; it does not prove a live
   login. Say so when you rely on it.
2. Prefer the server's tools over any shell command whenever the server is
   reachable. Never work around a missing or refused tool with a shell. If a
   tool is absent or answers NotAllowed, tell the human what you would need.
3. When you start a run, pass a requestId. If your turn is cut off, repeat
   start_run with the same requestId; it returns the run already started.
4. Narrate a run by looping on run_wait with the seq it returned. Report
   each meaningful event in one line. Use the summary field for the overall
   state. Stop looping when exited is true.
5. When a story or a run fails, call diagnose (with the story for an epic
   run) and explain the cause in your own words before you propose a rerun.
   Use story_detail and transcript_tail when diagnose is not enough.
6. Take costs only from the costs tool, never from a run's prose. When
   differs is true, give the total and say the ledger disagrees.
7. Treat a flow's claim of green gates or green tests as a claim. Check the
   gate logs in story_detail before you repeat it.
8. Ask the human before start_run when the scope or the expected cost is
   large: an epic, many stories, or several reviewers. Always ask before
   approve, and name the retro you are about to approve.
9. Only one flow that writes the checkout runs per repository. If start_run
   answers RunInProgress, report the running run instead of retrying.
10. Never put a token, a password or a key in a tool argument, a message or
    a memory.
```

## 2. Routines

Every 30 minutes:

```text
Call list_runs. For every run whose state is starting or running, call
run_status. Report only what changed since the last check: a story that
moved, a run that ended, a new warning. If nothing changed, say nothing.
```

Every morning at 8:00:

```text
Call list_epics, then costs without a runId, then retro_list for every epic
that ran since yesterday. Post one digest: epics with their board, what
yesterday cost, and retros waiting for approval.
```

## 3. Install the server

Do this on the machine that holds the repositories.

1. Install the CLI (Node.js 22 or later):

   ```bash
   npm i -g @llm4ts/shell
   ```

2. Create a token file only you can read:

   ```bash
   mkdir -p ~/.config/llm4ts
   umask 077 && openssl rand -hex 32 > ~/.config/llm4ts/mcp-token
   ```

3. Start the server under the supervisor you already use (systemd, launchd,
   tmux, pm2). Pass `--repo` once per repository:

   ```bash
   llm4ts mcp --http --repo /srv/code/nightcall --allow-run \
     --token-file ~/.config/llm4ts/mcp-token
   ```

   It listens on `127.0.0.1:4321` and serves `/mcp`. `--host` and `--port`
   change that. Without a token it refuses to start. Add `--allow-approve`
   only if the bot may approve retros. Instead of `--repo` you can list the
   repositories in `~/.config/llm4ts/mcp.json` as
   `{ "repos": [{ "id": "nightcall", "path": "/srv/code/nightcall" }] }`.
   Any `--repo` flag replaces that file; the two are not merged.

   The server starts each flow in its own process group and stops it
   itself (SIGINT, then SIGTERM after 30 s), so the stop signal must reach
   the server only. Under systemd, set `KillMode=mixed` (or `process`) in
   the unit; the default `control-group` signals the flows directly, and
   the server's own SIGINT then reaches them as a second signal, which
   kills them without cleanup.

4. From the computer the bot runs on, forward the port over ssh:

   ```bash
   ssh -N -L 4321:127.0.0.1:4321 <server>
   ```

5. In Grok Bot's MCP settings, add a server with the URL
   `http://127.0.0.1:4321/mcp` and the header
   `Authorization: Bearer <token>`, where `<token>` is the contents of the
   token file.

6. Ask the bot to call `preflight`. It should answer with the llm4ts and
   Node versions, the connectors and the roster.

What the setup protects:

- The token guards every HTTP request. A request without the exact
  `Authorization: Bearer <token>` header gets a bare `401`.
- The server never logs the token, never writes it to disk, and never puts
  it in an error. Its request log holds the method, the tool name, the
  duration and the status, never the arguments.
- The server binds loopback unless `--host` says otherwise and does no TLS.
  Reach it through the ssh forward, or a TLS reverse proxy you run.
- `start_run`, `stop_run` and `retro_start` exist only with `--allow-run`;
  `approve` exists only with `--allow-approve`. The token alone cannot add
  them.
- The bot names repositories by id, never by path, and cannot set
  environment variables. It cannot pass `--repo`, `-C`, `--prompt-file`,
  `--allow-mutating`, `--yes`, `--env` or `--target` to a flow.
- Run records and logs live in
  `${XDG_STATE_HOME:-~/.local/state}/llm4ts/mcp/<repoId>/`, outside the
  checkout. They hold the flow's arguments, never its environment.

## 4. Publish as a template

1. Create a bot in Grok Bot and give it the name, title, description and
   instructions from part 1.
2. Add the two routines from part 2.
3. Connect the server as in part 3 and check that `preflight` answers.
4. Use "Share as Template" and choose a public link. The template carries
   no server and no secret: each user connects their own server.
5. Record the link here.

Published template: not yet published.

## 5. Local variant (stdio)

When the bot, Claude Code or Cursor runs on the same machine as the
repositories, skip the token and the forward. Add an MCP server that the
client starts itself:

```json
{
  "mcpServers": {
    "llm4ts": {
      "command": "llm4ts",
      "args": ["mcp", "--stdio", "--repo", "<path>"]
    }
  }
}
```

Add `"--allow-run"` to `args` to let it start and stop flows. Over stdio
the client is the parent process, so no token is needed.
