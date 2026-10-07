# pack.md reference

The manifest is Markdown. Line 1 is `# Pack: <name>`. Header fields follow
as `key: value` lines until the first `## ` section.

## Header fields

| Field           | Required | Default        | Meaning                                                                                                      |
| --------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `source`        | yes      |                | Legacy technology name used in prompts and reports                                                           |
| `sources`       | no       | `.*`           | Regex over repo-relative paths: the files that make up the estate                                            |
| `exclude`       | no       |                | Regex removing paths from `sources`                                                                          |
| `programs`      | no       | every source   | Regex selecting the units extract writes one spec for                                                        |
| `scaffold`      | no       |                | Pack-relative directory seed copies into an empty target                                                     |
| `specs-dir`     | no       | `docs/specs`   | Target directory for specs                                                                                   |
| `features-dir`  | no       | `features`     | Target directory for `.feature` files                                                                        |
| `replay`        | no       |                | Command verify runs to replay equivalence vectors                                                            |
| `program-files` | no       | name substring | Regex template with `<NAME>` for the target files belonging to a program                                     |
| `spec-schema`   | no       |                | `pagespec`: every program spec must embed a decodable ```json pagespec block, checked by the extraction gate |

## Sections

- `## Gates`: `- <name>: <command>` lines. Run after every implement/verify
  task; failures are fed back to the coder.
- `## Judge`: `- <name> (0..<max>): <rubric>` lines. Extract scores each
  spec on every dimension.
- `## Equivalence`: `- ordering: ordered | unordered | per-key` and
  `- ignore: <field>,<field>` for verify's output comparison.
- `## Coverage: <name>`: `files: <regex>` and `unit: <regex>` (first capture
  group is the unit). Every captured unit must appear in the traceability
  matrix or the extract gate reports it uncovered.
- `## Survey: <name>`: same shape; captured units are file-to-file
  dependency-graph edges for the survey phase.
- `## Node: <kind>` (ADR 0030): `files:` regex over paths, `pattern:` regex
  over file contents (flags `gm`) whose `(?<name>…)` group names a sub-file
  node; every other named group becomes an attr; `attrs: a=b` copies group
  `b` into attr `a`; `descriptor: yes` marks a wiring record (contracted by
  the file projection); `anchor: <attr>` names the unit the node stands for.
- `## Edge: <kind>`: `files:`, `pattern:` with a `(?<to>…)` group and an
  optional `(?<thru>…)` range, `from:` the enclosing node kind (default
  `file`), `to:` the target node kind (default `file`, resolved same-file
  first).
- `## Join: <kind>`: `from: <kind>.<attr>`, `to: <kind>.<attr>`, `match:
exact | url` (servlet-spec order: exact, `/*` prefix, `*.ext`), `scope:
estate | app | file` (`url` defaults to `app`, the directory containing
  `WEB-INF`).
- `## Probe: <name>`: `from:` and `to:` node references (an id, `<kind>:<name>`
  or a file unit) that pack-check requires to be connected.
- `## Graph`: `- worklist-max: 200` and `- batch-size: 20` bound the survey's
  LLM pass over unresolved items.

## Sidecars

| Path                   | Read by                                  |
| ---------------------- | ---------------------------------------- |
| `prompts/analysis.md`  | extract                                  |
| `prompts/spec.md`      | extract                                  |
| `prompts/bdd.md`       | extract                                  |
| `prompts/plan.md`      | extract                                  |
| `prompts/implement.md` | implement                                |
| `prompts/review.md`    | review                                   |
| `prompts/vectors.md`   | verify                                   |
| `prompts/survey-*.md`  | survey (`refine`, `triage`; optional)    |
| `reviewers/<lens>.md`  | review; optional `files:` front matter   |
| `lessons.md`           | appended by review, read by later phases |

## Resolution

`LLM4TS_PACK` (or `llm4ts run --pack`; default `cobol-springboot`) is a
bare pack name resolved across the kits in the project (`.llm4ts/kits/`),
global (`~/.config/llm4ts/kits/`), and built-in tiers, `kit/pack` to name
one kit, or a path holding `pack.md` (relative to the launch directory, or
absolute) for a pack not yet in a kit. Two kits of one tier shipping the
same name is an error naming both.
