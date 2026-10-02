# Kit: j2ee-nextjs

JSP/servlet estates to Next.js, as a SPA over a mocked anti-corruption layer or behind a Spring BFF.

A kit bundles everything the engine's `modernize-*` flows need to know about
one legacy source and one target stack (ADR 0014). This one ships three
packs, the two scaffolds they seed an empty target from, the `convert-page`
and `convert-all` flows that drive the non-clean-room page conversion of
ADR 0012, and the demo-bank fixture (a legacy J2EE estate and its Next.js
target) the [workshop runbook](fixtures/demo-bank/RUNBOOK.md) rehearses on.

| Pack                                               | Legacy → target                  | Scaffold     | Replay |
| -------------------------------------------------- | -------------------------------- | ------------ | ------ |
| [`j2ee-nextjs-spa`](packs/j2ee-nextjs-spa/pack.md) | JSP/servlets → Next.js SPA + ACL | `nextjs-spa` | no     |
| [`jsp-nextjs`](packs/jsp-nextjs/pack.md)           | JSP/Java → Next.js SPA           | `nextjs-spa` | no     |
| [`jsp-bff-nextjs`](packs/jsp-bff-nextjs/pack.md)   | JSP/Java → Spring BFF + Next.js  | `spring-bff` | no     |

| Flow              | What it does                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `convert-page`    | Convert ONE extracted page into the Next.js target on its own branch                     |
| `convert-feature` | Convert ONE domain feature of the approved `domains.md`: one branch, one merged contract |
| `convert-all`     | Walk the approved domain map (features) or the survey inventory (pages), one branch each |

```sh
llm4ts run modernize-pack-check --pack j2ee-nextjs-spa --repo /path/to/legacy-estate
LLM4TS_LEGACY_REPO=/path/to/legacy-estate llm4ts run convert-page --pack j2ee-nextjs-spa --repo /path/to/nextjs accountOverview
```

The convert flows default to `j2ee-nextjs-spa`; `kits/test/packs.test.ts`
shows what the flows require of a manifest.

## Node for the gates

The Next.js scaffold pins Node 22 (`.nvmrc`, `package.json` `engines`). The
pack's gates run on the `node` on the PATH of the shell that launches
`llm4ts`, so `convert-*`, `modernize-implement` and `epic-stories` check it
against the target's pin before the first gate and stop, naming both, when
they disagree; `llm4ts doctor` reports the same under `gates:`. Switch Node
(`nvm use` / `fnm use`), or uncomment `use-node-version` in the target's
`.npmrc` so pnpm runs the pinned Node itself, or give the pack gates a
version-manager wrapper (`fnm exec --using=.nvmrc pnpm lint`). Set
`LLM4TS_NODE_CHECK=off` to run anyway.
