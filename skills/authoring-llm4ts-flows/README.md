# Installing the authoring-llm4ts-flows skill

[SKILL.md](SKILL.md) teaches coding agents how to write, verify, and fork
llm4ts flows under `.llm4ts/flows/`. It pairs with
[`using-llm4ts`](../using-llm4ts/README.md) (run a flow) and
[`authoring-llm4ts-packs`](../authoring-llm4ts-packs/README.md) (write a
modernization pack). Install it into your harness:

- **Claude Code**: as a plugin —
  `/plugin marketplace add riccardomerolla/llm4ts`, then
  `/plugin install authoring-llm4ts-flows@llm4ts-skills`. Or copy/symlink
  this directory to `~/.claude/skills/authoring-llm4ts-flows` (personal) or
  `<project>/.claude/skills/authoring-llm4ts-flows` (project) — no manifest
  needed.
- **Pi**: `pi install git:github.com/riccardomerolla/llm4ts` (pi
  auto-discovers the `skills/` directory). Or copy/symlink to
  `~/.pi/agent/skills/authoring-llm4ts-flows` (personal) or
  `<project>/.agents/skills/authoring-llm4ts-flows` (project).
- **OpenCode**: copy/symlink to
  `~/.config/opencode/skills/authoring-llm4ts-flows` (personal) or
  `<project>/.opencode/skills/authoring-llm4ts-flows` (project). OpenCode
  also scans `.claude/skills/`.
- **Codex**: copy/symlink to `~/.agents/skills/authoring-llm4ts-flows`
  (personal) or `<project>/.agents/skills/authoring-llm4ts-flows` (project).

The hello flow inside the skill is the shell's built-in `flows/hello.ts`,
the same text chapter 3 of the
[getting started guide](../../docs/guide/03-your-first-flow.md) shows; a
repository test pins all three to that file and runs it against the mock
provider so the skill cannot drift from the API.
