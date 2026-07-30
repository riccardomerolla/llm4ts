# Installing the using-llm4ts skill

[SKILL.md](SKILL.md) teaches coding agents when and how to delegate
implementation tasks to llm4ts. Install it into your harness:

- **Claude Code**: as a plugin —
  `/plugin marketplace add riccardomerolla/llm4ts`, then
  `/plugin install using-llm4ts@llm4ts-skills` (manifests: repo-root
  `.claude-plugin/marketplace.json`,
  `skills/using-llm4ts/.claude-plugin/plugin.json`). Or copy/symlink this
  directory to `~/.claude/skills/using-llm4ts` (personal) or
  `<project>/.claude/skills/using-llm4ts` (project) — no manifest needed.
- **Pi**: `pi install git:github.com/riccardomerolla/llm4ts` (pi
  auto-discovers the `skills/` directory; no manifest needed). Or
  copy/symlink to `~/.pi/agent/skills/using-llm4ts` (personal) or
  `<project>/.agents/skills/using-llm4ts` (project).
- **OpenCode**: copy/symlink to `~/.config/opencode/skills/using-llm4ts`
  (personal) or `<project>/.opencode/skills/using-llm4ts` (project) — no
  manifest needed. OpenCode also scans `.claude/skills/`, so the Claude Code
  symlink above is picked up too.
- **Codex**: copy/symlink to `~/.agents/skills/using-llm4ts` (personal) or
  `<project>/.agents/skills/using-llm4ts` (project) — no manifest needed.
  Codex has no package/marketplace install mechanism; directory placement is
  the whole story.
