# Discover flows and kits

A user lists the flows and kits available across the project, global and built-in tiers, and prints a flow's source before running it.

## Sub-features

- `discover-list` lists every flow with its tier and one-line description.
- `discover-view` prints one flow's source.
- `discover-kits` lists kits with their packs and flows.
- `discover-project-tier` shows a flow placed in the repository's `.llm4ts/flows/`.

## How to get to it (user POV)

- Run `llm4ts list`.
- Run `llm4ts view <flow>`.
- Run `llm4ts kits`.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.

- **List.** Run `$V cli $R discover-list -- list`. Exit code `0`. Stdout has one line per flow, and the lines for `implement` and `hello` carry `[builtin]`.
- **Kit flows.** Read the same stdout. `convert-page` carries `[builtin kit:j2ee-nextjs]`.
- **View.** Run `$V cli $R discover-view -- view hello`. Exit code `0`. Stdout starts with `// Hello: send one prompt to the configured provider and print the answer.`
- **Kits.** Run `$V cli $R discover-kits -- kits`. Exit code `0`. Stdout names `j2ee-nextjs`, `mainframe-java`, `port` and `soap-ace`, each with a `packs:` line.
- **Project tier.** Write a flow file to `$($V path $R repo)/.llm4ts/flows/`, then run `list` under a new label. The new flow's line carries `[project]` and the description from the file's first comment line.

## Gotchas

- The sandbox `HOME` is empty, so the global tier is empty. A change to global-tier lookup needs files placed under `$($V path $R sandbox)/home` first.
- `view` prints the bundled, transpiled `.js`, so type annotations from `flows/*.ts` are absent.
- A flow added under `flows/` is missing from `list` until `$V build` runs.
