# Configuration UX: synthesized design

Base: [candidate 1](candidate-1.md), "the environment, written down". The
cross-judge scored it above [candidate 2](candidate-2.md) on four of six
criteria (what the user types 5/3, single source 4/3, safety 4/3,
agent-proofness 5/3), level on predicate reachability (4/4) and below on
first-release cost (3/4). I read both end to end and reached the same base.

Candidate 1's usage section, scope table, precedence, file grammar and type
sketch stand as written unless this page says otherwise.

## The design in ten lines

1. One registry, `@llm4ts/flow/Settings`, keyed by the literal `LLM4TS_*`
   name. That name is the only spelling a user ever sees.
2. Each entry carries group, scope (`global`, `project`, `run`, `secret`,
   `internal`), a shared value grammar, a fallback, a doc sentence, and the
   optional `flag`, `requiredBy`, `shellOnly`.
3. Two files in a strict dotenv subset: `~/.config/llm4ts/config.env` and
   `<repo>/.llm4ts/config.env`. A runbook's `export` block is a valid file.
4. Precedence: flag and `--set` > environment > project file > global file >
   default. Existing exports keep their meaning.
5. The shell resolves once per command and hands the flow child a complete
   environment through a branded `FlowEnvironment`. No flow script changes.
6. `llm4ts config show | set | unset | init`; `run` gains `--set NAME=value`
   and `--coder`.
7. New surface (files, `--set`, `config set`) is strict from day one. The
   environment only warns in 3.x.
8. Secrets, run-scoped and internal settings never enter a file.
9. `docs/configuration.md` carries a generated reference; one test file holds
   the drift checks.
10. Readers migrate behind the registry afterwards, one area per change.

## Changes made in synthesis

| Change                                                                                                                  | Source                                  | Why                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A file or `--set` toggle is projected to the child as `1` for on and `off` for off, not passed through verbatim         | candidate 2's wire spelling, simplified | The judge found readers that accept only `1` (`LLM4TS_FAIL_FAST`, `LLM4TS_MARK_DEEPEN`), only `1` or `true` (`LLM4TS_TIMESTAMPS`), or react only to `off` (`LLM4TS_TOOL_BRIEF`, `LLM4TS_PORT_GUIDE_TRIAL`). One canonical pair that every current reader reads correctly needs no per-setting field. A test proves it per toggle. |
| Unconditional `requiredBy` pairs are checked by the shell before the child is spawned, in the first release             | candidate 2                             | Predicate 4 then needs no flow change. `requireSetting` in the flow stays for requirements that depend on the flow's mode.                                                                                                                                                                                                        |
| `epic-design` leaves `requiredBy` for `LLM4TS_LEGACY_REPO`                                                              | judge                                   | `epic-design -- --list` returns before the check, so the pair is conditional.                                                                                                                                                                                                                                                     |
| `config show` lists foreign credentials (`ANTHROPIC_API_KEY`, …) as set or unset, never a value                         | candidate 2                             | The first question on a fresh machine is "does it see my key".                                                                                                                                                                                                                                                                    |
| A launch warns about an unknown `LLM4TS_*` name only when a known name is close; `config show` lists every unknown name | mine                                    | A user's own flow may read its own `LLM4TS_*` name. A typo warning on every run for a name that is no typo would train people to ignore the line. This replaces candidate 2's kit-local declaration files with no new mechanism.                                                                                                  |
| `refine` also gains `LLM4TS_FLOW` through the branded launcher                                                          | judge                                   | Candidate 1 named only the menu.                                                                                                                                                                                                                                                                                                  |

## Rejected

- **Kebab names derived from the variable (candidate 2).** A second
  vocabulary beside the names every doc, error and flow comment already
  uses, and the registry would hold no `LLM4TS_` text to grep.
- **JSON files (candidate 2).** No comments, typed values that differ from
  what the environment carries, and no paste path from an `export` block.
- **Kit-local `settings.json` declarations (candidate 2).** The kits that
  exist ship in this repository, so one table covers them. Revisit when a
  kit lives elsewhere.
- **`flows` lists per setting (candidate 2).** A hand-kept list no check can
  fully prove.

## Open decisions for the owner

1. File format and spelling: dotenv with `LLM4TS_*` names (recommended), or
   JSON with short names. One-way door.
2. Is the project file local to a clone (recommended; `.llm4ts/` is
   git-ignored by the tool itself) or committed for a team? Committed needs
   a location outside `.llm4ts/` and a trust step for settings that run
   commands (gates, worktree setup, test-one).
3. `config show` default: only settings not at their default (recommended),
   or all of them.

Neither decision blocks unit 1.

## Units

| #   | Unit                                                                                                            | Check                                                        | Release |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| 1   | Registry of every name, grammars, `closestSettingName`, and the sync test (code names ⊆ registry, no dead rows) | the test fails on an added unknown name and on a deleted row | 3.3.0   |
| 2   | `config show` over the environment; typo warning at launch                                                      | golden output; `verify-llm4ts` run with a misspelled export  | 3.3.0   |
| 3   | Files, resolution, `--set`, `--coder`, `config set/unset/init`, shell preflight, ADR 0049                       | precedence matrix tests; sandbox run with no prefix          | 3.3.0   |
| 4   | Generated reference in `docs/configuration.md`                                                                  | hand edit fails the test                                     | 3.3.0   |
| 5   | Runbooks without prefixes                                                                                       | prefixed fences go 28 → 0 and stay                           | 3.3.0   |
| 6   | Runner readers through `settingValue`                                                                           | existing tests unchanged                                     | later   |
| 7   | Flow, flows/lib and kit readers migrate; `requireSetting`                                                       | ratchet of raw reads only falls                              | later   |
| 8   | 4.0.0: a bad environment value refuses the launch                                                               | flow smokes                                                  | 4.0.0   |
