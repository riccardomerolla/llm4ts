# Chat

The owner runs `llm4ts chat` in a repository; the Chief of Staff posts a listening line to a Google Chat space, answers `/bot` requests in their thread, starts allowed flows and posts their end, until Ctrl-C (ADR 0052). Here the space is a stand-in `gws`, so no Google account is involved.

## Sub-features

- `chat-no-space` refuses to start without a space (exit 2).
- `chat-listen` posts the listening line.
- `chat-answer` answers `/bot what is running?` in the request's thread.
- `chat-start` starts `implement` from `/bot implement …` and posts the run's ending line with branch and commits.
- `chat-observe` prints what it would reply and start, and posts nothing.
- `chat-stop` ends on SIGINT with exit 0.

## How to get to it (user POV)

- Run `llm4ts chat --space <space> [--observe]` in the repository; type `/bot …` in the space.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.
- The stand-in `gws` is on the sandbox `PATH`: `S=$($V path $R sandbox); cp .claude/skills/verify-llm4ts/stubs/gws.cjs $S/bin/gws; chmod +x $S/bin/gws`. It keeps the space in `$S/gws/` (`messages.jsonl`, and `posted.log` for what llm4ts posted, one `<thread> <text>` line each); `$S/bin/gws say users/OWNER "<text>"` types a message as that user. Every line llm4ts posts is sent as `users/OWNER`, so that is the owner.
- The stub agent answers both the Chief and the implement run: `$V stub $R "$PWD/.claude/skills/verify-llm4ts/stubs/chief.cjs"` (an absolute path: the stub `require`s it from the sandbox).
- `chat` runs until signalled, so start it in the background with the environment `$V cli` uses, from the sandbox repository:

  ```bash
  E=$($V path $R evidence); cd "$S/repo"
  env -i PATH="$S/bin:$PATH" HOME="$S/home" TMPDIR="${TMPDIR:-/tmp}" NO_COLOR=1 LLM4TS_CODER=claude \
    node "$OLDPWD/packages/shell/dist/cli-main.js" chat --space spaces/TEST --interval 1 \
    >"$E/chat-live.stdout" 2>"$E/chat-live.stderr" & P=$!; cd "$OLDPWD"
  ```

- **No space.** `$V cli $R chat-no-space -- chat`. Exit `2`; stderr says `chat needs a space`.
- **Listen.** After the start, `$S/gws/posted.log` has `🌙 chief: Listening. Repository repo. I may start: implement.`
- **Answer.** `$S/bin/gws say users/OWNER "/bot what is running?"`; within ~15 s `posted.log` has `🌙 chief: Runs I know of: …` on that message's thread.
- **Start.** `$S/bin/gws say users/OWNER "/bot implement add a hello file"`; within ~60 s `posted.log` has `🌙 chief: Starting implement. (run op-…)` and then `op-… completed in 0 min, $0.00. Branch calculator, 2 commits.` `$V snapshot $R chat-start` shows the `calculator` branch with two commits.
- **Stop.** `kill -INT $P`; the process exits 0 and its stdout ends with `Stopping; runs started from chat are stopped too.`
- **Observe.** Start again with `--observe`, `say` from `users/STRANGER` and from `users/OWNER`. Stdout has `/bot from users/STRANGER (?)` with the would-be stranger reply, and `would start implement: …` for the owner; `posted.log` gains nothing.

## Gotchas

- The implement run leaves its branch checked out. The loop returns to the branch it first started on before the next run, so nothing stacks, but a snapshot taken in between shows the run's branch as HEAD.
- A relative responder path makes every decision `I could not work that out.`: that is the Chief's `Failed` reply when its seat fails. The chat's stdout says `The Chief could not decide on …` with the chief run's id and its log directory under `$S/home/.local/state/llm4ts/mcp/repo/runs/`.
- Only the stand-in is proven here. The real `gws` JSON and how Chat delivers a typed `/bot` are unverified until a real Workspace space is used.
