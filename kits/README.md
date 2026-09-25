# Kits

A kit is the directory that bundles everything stack-specific the engine
flows consume: pack manifests with their prompt and reviewer sidecars, the
scaffolds those packs seed an empty target from, a deck of translation
pattern cards, and any flows that only make sense for that stack (ADR 0014).
The engine flows in [`flows/`](../flows/README.md) know nothing about COBOL,
JSP, Spring, or Next.js; a kit is where that knowledge lives.

```text
<kit>/
  README.md          first paragraph = the kit's one-line description
  packs/<name>/      pack.md + prompts/ + reviewers/ (+ patterns/, lessons.md)
  scaffolds/<name>/  copied into an empty target by modernize-seed
  patterns/          the kit's translation cards, injected by extract and implement
  flows/             optional kit-specific flows (with their lib/)
  fixtures/          optional rehearsal material
```

Three kits ship as built-ins:

| Kit                                | Legacy → target                                   | Packs | Flows                                         |
| ---------------------------------- | ------------------------------------------------- | ----- | --------------------------------------------- |
| [`mainframe-java`](mainframe-java) | COBOL/JCL and ACE → Spring Boot and Kafka Streams | 4     |                                               |
| [`j2ee-nextjs`](j2ee-nextjs)       | JSP/servlets → Next.js SPA or Spring BFF          | 3     | `convert-page`, `convert-all`                 |
| [`soap-ace`](soap-ace)             | SOAP services → REST APIs on IBM ACE 12           | 0     | `soap-discover`, `soap-sample`, `soap-design` |

## Where kits are found

Kits are discovered in the same three tiers as flows, project > global >
built-in by kit name:

| Tier    | Directory                      |
| ------- | ------------------------------ |
| project | `./.llm4ts/kits/<kit>/`        |
| global  | `~/.config/llm4ts/kits/`       |
| builtin | shipped inside `@llm4ts/shell` |

`llm4ts kits` lists them with their packs and flows; a kit's flows appear in
`llm4ts list` labelled with the kit's name.

## Selecting a pack

`llm4ts run <flow> --pack <ref>` (or `LLM4TS_PACK=<ref>`) accepts:

- a bare pack name, `cobol-springboot`, resolved across every discovered
  kit — an error names the candidates when two kits of the same tier ship it;
- `kit/pack`, `mainframe-java/cobol-springboot`, to name one kit;
- a directory holding `pack.md`, relative to the launch directory or
  absolute, for a pack you are still writing.

`cobol-springboot` is the default. `modernize-pack-check` verifies any of
the three forms against an estate without a model call.

## Writing a kit

Copy the closest built-in kit into `.llm4ts/kits/<name>/`, edit or replace
its packs, run `modernize-pack-check --pack <name>` until every rule
captures real units, and `llm4ts kits` shows it. Chapter 5 of the
[getting started guide](../docs/guide/05-your-first-pack.md) walks through
the manifest; [`kits/test/packs.test.ts`](test/packs.test.ts) states what
the flows require of a shipped pack.
