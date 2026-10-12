# Process-group termination in the Node process executor

Stop orphaning a harness's children: spawn with its own process group,
signal the group on close, and report what remained as an `Info` event
instead of claiming a clean stop. Item 8 of
`docs/research/rea-gap-analysis.md` section 6; a fix to a gap llm4zio's
executor shared, recorded in `docs/parity.md`.

Driver: `killChild` sends `SIGKILL` to the child pid only
(`NodeProcessExecutor.ts`); a cancelled gate or a stalled coder can leave
`vitest`, a dev server or `cargo` running in a worktree the next story
reuses, holding ports and files.

## Decisions

| Decision | Choice                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn    | `detached: true` on POSIX so the child leads its own group; stdio stays piped; the parent still waits on it (no `unref`).                                                        |
| Kill     | `SIGTERM` to the group (`process.kill(-pid)`), then `SIGKILL` to the group after a short grace (`LLM4TS_PROCESS_GRACE_MS`, default 2000) when the child has not exited.          |
| Windows  | `WindowsCommand.ts` path: `taskkill /T /F /PID` through the existing invocation helper; same grace.                                                                              |
| Report   | After the kill, a best-effort check of the group (`kill(-pid, 0)` on POSIX); survivors are published as an `Info` with the pid and argv head, never as success.                  |
| Scope    | Every spawn through `NodeProcessExecutor` (gates, CLI connectors, bridges); a harness that must outlive its parent gets an explicit `ownGroup: false` option (none known today). |

## Modules

- `packages/runner/src/NodeProcessExecutor.ts`: spawn options, group kill,
  grace, survivor check.
- `packages/core/src/ProcessExecutor.ts`: `ProcessOptions.ownGroup?` and a
  `remaining?: number` on the result for the cancelled path, if the shape
  needs it; otherwise the `Info` event suffices.
- `packages/runner/src/WindowsCommand.ts`: the taskkill invocation.

## Tasks

- [ ] Group spawn and kill on POSIX with the grace; a test that spawns a
      shell with a sleeping child and asserts the child is gone after
      cancellation (process-based, kept under one second with a short
      grace).
- [ ] Windows path; unit test on the argv built.
- [ ] Survivor `Info` event; test with a fake `kill` that reports a
      survivor.
- [ ] `docs/configuration.md` variable, `docs/parity.md` note, CHANGELOG.

## Tests

One real-process test (the repository already runs process-based executor
tests); the rest with fakes.

## Non-goals

Process ownership proofs as rea keeps them; cgroups or containers; killing
processes llm4ts did not spawn.
