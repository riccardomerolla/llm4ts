# Installing the using-pack-fork skill

[SKILL.md](SKILL.md) teaches coding agents when and how to fork an existing
llm4ts pack into a new one that captures a real, already-in-production
target repository's own conventions (tech stack, naming, shared components,
auth, design system), so a later `modernize-implement` run reuses them
instead of guessing. Install it into your harness:

- **Claude Code**: as a plugin —
  `/plugin marketplace add riccardomerolla/llm4ts`, then
  `/plugin install using-pack-fork@llm4ts-skills` (manifests: repo-root
  `.claude-plugin/marketplace.json`,
  `skills/using-pack-fork/.claude-plugin/plugin.json`). Or copy/symlink this
  directory to `~/.claude/skills/using-pack-fork` (personal) or
  `<project>/.claude/skills/using-pack-fork` (project) — no manifest needed.
- **Pi**: `pi install git:github.com/riccardomerolla/llm4ts` (pi
  auto-discovers the `skills/` directory; no manifest needed). Or
  copy/symlink to `~/.pi/agent/skills/using-pack-fork` (personal) or
  `<project>/.agents/skills/using-pack-fork` (project).
- **OpenCode**: copy/symlink to `~/.config/opencode/skills/using-pack-fork`
  (personal) or `<project>/.opencode/skills/using-pack-fork` (project) — no
  manifest needed. OpenCode also scans `.claude/skills/`, so the Claude Code
  symlink above is picked up too.
- **Codex**: copy/symlink to `~/.agents/skills/using-pack-fork` (personal) or
  `<project>/.agents/skills/using-pack-fork` (project) — no manifest needed.
  Codex has no package/marketplace install mechanism; directory placement is
  the whole story.
