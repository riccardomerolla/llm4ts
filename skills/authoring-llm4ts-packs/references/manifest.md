# pack.md reference

The manifest is Markdown. Line 1 is `# Pack: <name>`. Header fields follow
as `key: value` lines until the first `## ` section.

## Header fields

| Field          | Required | Default        | Meaning                                                                  |
| -------------- | -------- | -------------- | ------------------------------------------------------------------------ |
| `source`       | yes      |                | Legacy technology name used in prompts and reports                       |
| `sources`      | no       | `.*`           | Regex over repo-relative paths: the files that make up the estate        |
| `exclude`      | no       |                | Regex removing paths from `sources`                                      |
| `programs`     | no       | every source   | Regex selecting the units extract writes one spec for                    |
| `scaffold`     | no       |                | Pack-relative directory seed copies into an empty target                 |
| `specs-dir`    | no       | `docs/specs`   | Target directory for specs                                               |
| `features-dir` | no       | `features`     | Target directory for `.feature` files                                    |
| `replay`       | no       |                | Command verify runs to replay equivalence vectors                        |
| `programFiles` | no       | name substring | Regex template with `<NAME>` for the target files belonging to a program |

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
- `## Survey: <name>`: same shape; captured units are dependency-graph edges
  for the survey phase.

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

`LLM4TS_PACK` (default `packs/cobol-springboot`) is resolved against the
launch directory, then against the flow script's directory where the shell
ships the built-in packs. An absolute path is used as-is.
