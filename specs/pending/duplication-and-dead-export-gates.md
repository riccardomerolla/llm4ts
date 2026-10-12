# Duplication and dead-export gates

Make "deep modules over parallel code" checkable: `jscpd` at a threshold
measured on the current tree and `knip` for unused exports and
dependencies, both under `pnpm lint`, so CI fails on new duplication and
dead surface. Item 9 of `docs/research/rea-gap-analysis.md` section 6; no
ADR.

Driver: CLAUDE.md forbids one-off variants by rule; the ADR 0026
deprecations and the growth of `flows/lib` are where parallel code
accumulates unseen; rea runs `knip` at error and `jscpd` at 3%.

## Decisions

| Decision  | Choice                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools     | `jscpd` and `knip` as root dev dependencies, pinned exactly like every other dev dependency.                                                                           |
| Scope     | `packages/*/src`, `flows`, `kits`, `examples`; tests, `dist`, `.repos` and fixtures excluded.                                                                          |
| Threshold | `jscpd` `--threshold` set to the duplication measured on the first run, rounded up to the next half percent; a `TODO` in `.jscpd.json` names the ratchet target of 3%. |
| knip      | Unused exports, files and dependencies at `error`; entries listed explicitly for the five packages' subpath exports and the flows the CLI discovers.                   |
| Script    | `pnpm lint` runs eslint, then `jscpd`, then `knip`; `pnpm lint:dup` and `pnpm lint:dead` run them alone.                                                               |
| First run | Findings triaged in the same PR: deleted when dead, deduplicated when cheap, ignored by config with a comment when deliberate (connector fakes, kit scaffolds).        |

## Tasks

- [ ] Dependencies and configs; `pnpm lint` green on the current tree.
- [ ] First-run triage recorded in the PR description with counts before
      and after.
- [ ] CI unchanged (it already runs `pnpm lint`); `CLAUDE.md` Verification
      section names the two gates.
- [ ] CHANGELOG.

## Tests

None beyond the gates themselves running in CI.

## Non-goals

A module-boundary verifier (the `tsc -b` project references already
enforce the package graph); TODO scanning.
