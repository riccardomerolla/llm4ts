# Installing the authoring-llm4ts-packs skill

[SKILL.md](SKILL.md) teaches coding agents how to write a modernization
pack for llm4ts's `modernize-*` flows and check it against an estate with
`modernize-pack-check`, which makes no model call. It pairs with
[`using-llm4ts`](../using-llm4ts/README.md) (run a flow) and
[`authoring-llm4ts-flows`](../authoring-llm4ts-flows/README.md) (write a
flow). Install it into your harness:

- **Claude Code**: as a plugin —
  `/plugin marketplace add riccardomerolla/llm4ts`, then
  `/plugin install authoring-llm4ts-packs@llm4ts-skills`. Or copy/symlink
  this directory to `~/.claude/skills/authoring-llm4ts-packs` (personal) or
  `<project>/.claude/skills/authoring-llm4ts-packs` (project) — no manifest
  needed.
- **Pi**: `pi install git:github.com/riccardomerolla/llm4ts` (pi
  auto-discovers the `skills/` directory). Or copy/symlink to
  `~/.pi/agent/skills/authoring-llm4ts-packs` (personal) or
  `<project>/.agents/skills/authoring-llm4ts-packs` (project).
- **OpenCode**: copy/symlink to
  `~/.config/opencode/skills/authoring-llm4ts-packs` (personal) or
  `<project>/.opencode/skills/authoring-llm4ts-packs` (project). OpenCode
  also scans `.claude/skills/`.
- **Codex**: copy/symlink to `~/.agents/skills/authoring-llm4ts-packs`
  (personal) or `<project>/.agents/skills/authoring-llm4ts-packs` (project).

The template under `references/` is the same manifest as chapter 5 of the
[getting started guide](../../docs/guide/05-your-first-pack.md); a
repository test loads it with the real pack loader so the skill cannot
drift from the manifest format.
