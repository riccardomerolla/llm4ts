# @llm4ts/shell

Interactive shell and CLI for [llm4ts](https://github.com/riccardomerolla/llm4ts):
the `llm4ts` command that discovers flows, runs them with your coding agent,
and ships the built-in flows and kits.

## Install

```bash
npm install -g @llm4ts/shell
```

Requires Node.js >= 22.

## The `llm4ts` command

```bash
llm4ts                 # interactive menu
llm4ts list            # project, global and built-in flows
llm4ts run implement --coder codex "Add a multiply function next to add, with tests"
llm4ts view hello      # print a flow's source, to fork it under .llm4ts/flows/
llm4ts config show     # effective settings and where each comes from
```

Flows are plain TypeScript scripts; a project keeps its own under
`.llm4ts/flows/`, and the shell resolves `@llm4ts/runner` and `effect` from
its own installation, so a project flow needs no `npm install`.

## Documentation

- [Repository and full documentation](https://github.com/riccardomerolla/llm4ts)
- [Configuration guide](https://github.com/riccardomerolla/llm4ts/blob/main/docs/configuration.md)

## License

MIT
