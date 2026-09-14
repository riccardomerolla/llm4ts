# Kit: mainframe-java

COBOL/JCL and IBM ACE estates to Spring Boot and Kafka Streams services.

A kit bundles everything the engine's `modernize-*` flows need to know about
one legacy source and one target stack (ADR 0014). This one ships four packs,
the two scaffolds they seed an empty target from, and a deck of 25 COBOL
translation pattern cards that extraction tags onto each program's
traceability and implementation injects into the coder's prompt.

| Pack                                                 | Legacy → target                   | Scaffold                | Replay |
| ---------------------------------------------------- | --------------------------------- | ----------------------- | ------ |
| [`cobol-springboot`](packs/cobol-springboot/pack.md) | COBOL/JCL → Spring Boot service   | `spring-boot-service`   | yes    |
| [`cobol-kafka`](packs/cobol-kafka/pack.md)           | COBOL/JCL → Kafka Streams service | `kafka-streams-service` | yes    |
| [`ace-integration`](packs/ace-integration/pack.md)   | ACE msgflow/ESQL → Spring Boot    | `spring-boot-service`   | no     |
| [`ace-kafka`](packs/ace-kafka/pack.md)               | ACE msgflow/ESQL → Kafka Streams  | `kafka-streams-service` | yes    |

Packs without a `replay:` command run phases 0–3 and 5; phase 4 needs a
replay harness in the target repository to drive equivalence vectors.
`cobol-kafka` adds its own cards under `packs/cobol-kafka/patterns/` for
event-streaming idioms on top of the kit's deck.

```sh
llm4ts run modernize-pack-check --pack cobol-springboot --repo /path/to/legacy-estate
llm4ts run modernize-survey --pack cobol-springboot --repo /path/to/legacy-estate
```

`cobol-springboot` is the default pack when `--pack` and `LLM4TS_PACK` are
both unset. Copy a pack directory next to your work and pass its path to
iterate on it before it joins a kit; `kits/test/packs.test.ts` shows what
the flows require of a manifest.
