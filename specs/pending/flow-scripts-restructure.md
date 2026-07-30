# Flow Scripts Restructure: examples/ → flows/

Restructure the runnable agent flows out of `examples/` into a top-level
`flows/` directory whose scripts double as the shell's built-in flows
(see `specs/pending/llm4ts-shell.md`, which depends on this spec). This
mirrors orca's move of `examples/*.sc` to `flows/` (orca ADR 0021 §7),
adapted to npm packaging: flow files ship as real files inside the
`@llm4ts/shell` package — no jar-style embedding or extraction.

## Decisions (agreed 2026-07-29)

| Decision         | Choice                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What moves       | The agent flows: `implement.ts`, `issue-pr.ts`, `sdd.ts`, `local.ts`, `judge-suite.ts`. Deterministic library demos (`basic.ts`, `plain-js.mjs`, `api-provider.ts`, `docs.ts`) stay in `examples/`. `cli-implement.ts` (a one-line re-import) is deleted. |
| Helpers          | Flows import published subpaths directly (`@llm4ts/runner/FlowArgs` `resolveFlowInput`, `@llm4ts/runner/FlowRunner` `runFlowMain`, …). `examples/support.ts` is already only a rename shim over these — delete it. No new API is needed.                  |
| Self-containment | Each flow is a single file importing only `@llm4ts/*`, `effect`, and `node:*` — no relative imports. This is the flow-script contract the shell relies on.                                                                                                |
| Description      | Line 1 of every flow is a `//` comment whose text is the flow's one-line description (ported orca convention, ADR 0021 §5). The shell's discovery listing reads it.                                                                                       |
| Task input       | Flows keep taking the task text via argv / `resolveFlowInput`, so `node --experimental-strip-types flows/implement.ts "task"` keeps working directly, with or without the shell.                                                                          |

## Tasks

- [ ] Create top-level `flows/` with the five flow scripts, each rewritten to
      import published subpaths only (no `./support.ts`), with a first-line
      `//` description comment.
- [ ] Delete `examples/support.ts` and `examples/cli-implement.ts`; update the
      remaining examples that imported `support.ts` (`api-provider.ts`) to
      import the published subpaths directly.
- [ ] Give `flows/` its own `tsconfig.json` (mirroring `examples/`') so
      `pnpm typecheck` covers every flow script; wire it into the root
      build/typecheck chain.
- [ ] Update `examples/seed.sh` mappings, `examples/README.md`, and the root
      `README.md` to point at `flows/` for the agent flows; `examples/README.md`
      keeps only the deterministic demos. `examples/starters/` stays where it
      is (target-repo templates, not flows).
- [ ] Verify each moved flow still runs identically by inspection of its diff
      (imports and paths only — no behavior change), and run the full
      verification chain.

## Non-goals

- No shell package yet (next spec).
- No new runner API: if a flow needs a helper that is not exported, that is a
  finding — extend the existing seam (`FlowArgs`/`FlowRunner`), do not create
  a parallel helpers module.

## References

- `examples/support.ts` (the shim proving the exports already exist)
- `packages/runner/src/FlowArgs.ts`, `packages/runner/src/FlowRunner.ts`
- orca ADR 0021 §5 (description rule), §7 (built-in flows move):
  `/Users/riccardo/git/github/riccardomerolla/orca/adr/0021-orca-shell.md`
