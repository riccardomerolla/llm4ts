# specs/

Actionable implementation plans for autonomous and semi-autonomous work on
llm4ts. This directory is the work queue; the canonical engineering
documentation lives elsewhere and always takes precedence:

- `CLAUDE.md` — non-negotiable rules and the verification chain
- `plan.md` — scope, package boundaries, pinned baselines, delivery phases
- `docs/` — architecture, API, configuration, provider capabilities, parity
  ledger, ADRs, and the CSP contracts

## Layout

| Directory       | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `pending/`      | Specs waiting to be implemented. Agents work from here. |
| `completed/`    | Specs the user has accepted and moved here manually.    |
| `architecture/` | Orientation notes that point into the canonical docs.   |

## Conventions

- One spec per file, named `kebab-case.md`, with a task checklist agents can
  tick off (`- [ ]` / `- [x]`) as work lands.
- Specs describe **what** and **why**, cite the relevant contracts
  (`docs/csp/*`, `docs/parity.md`) and seams to extend, and leave **how** to
  the implementer within the CLAUDE.md rules.
- Agents update task status inside a pending spec but never move a spec to
  `completed/` — only the user decides a spec is done.
- Run `./ralph-auto.sh "<focus>"` to work a spec autonomously; the script owns
  git commits and enforces the verification chain.
