# using-llm4ts Agent Skill

Ship an installable agent skill that teaches coding harnesses (Claude
Code, Pi, OpenCode, Codex) when and how to delegate a well-defined
implementation task to llm4ts instead of implementing it themselves — a
straight port of orca's `skills/using-orca` adapted to the llm4ts shell
CLI.

Depends on `specs/pending/llm4ts-shell.md`: the skill teaches the shell's
`run`/`list` verbs, so it lands only after they exist.

## Decisions (agreed 2026-07-29)

| Decision   | Choice                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape      | Straight port of orca's skill: one `skills/using-llm4ts/SKILL.md` + install `README.md` + Claude Code plugin manifests. No per-flow guidance beyond naming `llm4ts list`.                                                                                         |
| Invocation | `npx -y @llm4ts/shell run <flow> "<task>"` so the skill works headlessly on any machine with Node 22+, no global install assumed.                                                                                                                                 |
| Install    | Claude Code: plugin marketplace (repo-root `.claude-plugin/marketplace.json` + `skills/using-llm4ts/.claude-plugin/plugin.json`) or copy/symlink to `~/.claude/skills` / `<project>/.claude/skills`. Pi, OpenCode, Codex: copy/symlink paths as in orca's README. |

## Tasks

- [ ] `skills/using-llm4ts/SKILL.md` with frontmatter (`name`,
      `description`) covering: when to delegate (well-defined,
      self-contained task with clear acceptance criteria) and when NOT
      (exploratory/interactive work, trivial edits); the
      `npx -y @llm4ts/shell run implement "<task>"` invocation with
      `llm4ts list` for other flows;
      the `LLM4TS_CODER` env var for connector selection;
      the exit-code contract (0/1/2, `run` propagates the flow); and the
      resume story (flows are resumable — re-run the same command, the
      persisted plan picks up from the last completed task).
- [ ] `skills/using-llm4ts/README.md`: per-harness install matrix ported
      from orca's (Claude Code plugin + copy/symlink; Pi; OpenCode; Codex).
- [ ] Plugin manifests: repo-root `.claude-plugin/marketplace.json` and
      `skills/using-llm4ts/.claude-plugin/plugin.json`.
- [ ] Every command in the skill is verified against the real shell CLI
      before the skill text is written (no aspirational flags); the
      SKILL.md stays under one screen — it is prompt context, not docs.
- [ ] Link the skill from the root `README.md`.

## Non-goals

- No skill-side flow catalog or per-flow decision tree (revisit if agents
  pick wrong flows in practice).
- No auto-install tooling; directory placement and the plugin marketplace
  are the whole story.

## References

- orca skill: `/Users/riccardo/git/github/riccardomerolla/orca/skills/using-orca/{SKILL.md,README.md}`
- `specs/pending/llm4ts-shell.md` (the CLI contract the skill teaches)
