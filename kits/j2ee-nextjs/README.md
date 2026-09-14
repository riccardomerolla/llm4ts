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

| Flow           | What it does                                                           |
| -------------- | ---------------------------------------------------------------------- |
| `convert-page` | Convert ONE extracted page into the Next.js target on its own branch   |
| `convert-all`  | Walk the survey inventory in wave order, one branch per page, a report |

```sh
llm4ts run modernize-pack-check --pack j2ee-nextjs-spa --repo /path/to/legacy-estate
LLM4TS_LEGACY_REPO=/path/to/legacy-estate llm4ts run convert-page --pack j2ee-nextjs-spa --repo /path/to/nextjs accountOverview
```

The convert flows default to `j2ee-nextjs-spa`; `kits/test/packs.test.ts`
shows what the flows require of a manifest.
