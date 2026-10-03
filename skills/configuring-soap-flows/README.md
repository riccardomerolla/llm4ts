# Installing the configuring-soap-flows skill

[SKILL.md](SKILL.md) teaches coding agents how to get llm4ts's soap-ace
flows talking to a real ESB in a locked-down environment: one profile per
environment, explicit proxies, a trusted chain pinned behind its
fingerprint, and a SAML token from an STS. Install it into your harness:

- **Claude Code**: as a plugin —
  `/plugin marketplace add riccardomerolla/llm4ts`, then
  `/plugin install configuring-soap-flows@llm4ts-skills` (manifests:
  repo-root `.claude-plugin/marketplace.json`,
  `skills/configuring-soap-flows/.claude-plugin/plugin.json`). Or
  copy/symlink this directory to `~/.claude/skills/configuring-soap-flows`
  (personal) or `<project>/.claude/skills/configuring-soap-flows` (project).
- **Pi**: `pi install git:github.com/riccardomerolla/llm4ts` (pi
  auto-discovers the `skills/` directory). Or copy/symlink to
  `~/.pi/agent/skills/configuring-soap-flows` or
  `<project>/.agents/skills/configuring-soap-flows`.
- **OpenCode**: copy/symlink to
  `~/.config/opencode/skills/configuring-soap-flows` or
  `<project>/.opencode/skills/configuring-soap-flows`. OpenCode also scans
  `.claude/skills/`.
- **Codex**: copy/symlink to `~/.agents/skills/configuring-soap-flows` or
  `<project>/.agents/skills/configuring-soap-flows`.
