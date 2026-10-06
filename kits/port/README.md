# port

Language-to-language ports, file by file, the way Bun was rewritten from Zig
to Rust in May 2026 (ADR 0028): a rulebook the human writes with the model, a
pilot of a few files behind an approval, then every source file drafted at its
target path by one implementer with exactly one source in view, reviewed by
two adversarial votes, fixed by a separate fixer, ending in a `PORT STATUS`
trailer; then compiler diagnostics worked as a queue, one unit per fixer, one
rebuild per round. The source stays in the tree as the spec: this kit is not
clean-room.

```text
kits/port/
  packs/zig-rust/     the reference pair, distilled from the Bun port
    pack.md           sources:, target:, comment:, ## Gates, ## Diagnostics
    prompts/porting.md   the rulebook every implementer reads whole
    reviewers/         lenses that diff source and target
    patterns/pitfalls-zig-rust.md   syntactically alike, semantically different
```

Flows, in the order a port runs them: `port-guide` (audit the rulebook on a
few samples, behind an approval), `port-ledger` (classify the units the pack
names into `ledger.tsv`), `port-files` (drafts, with a pilot), `port-compile`
(diagnostics as a queue), `port-tests` (the differential tier). A pack for
another pair copies one of these and replaces the rulebook, the pitfall card,
`target:`, the diagnostics command, the ledger regex and the two test
commands.

| Pack                    | Source → target                                                                                          | Diagnostics                             | Ledger units                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `zig-rust`              | Zig → Rust                                                                                               | `cargo check --message-format=json`     | pointer and slice fields          |
| `scala-ts`              | Scala 3 / ZIO 2 → TS / Effect 4                                                                          | `tsc --pretty false`                    | classes, objects, traits          |
| `cobol-springboot-port` | COBOL → Java / Spring Boot 3 (file by file; the clean-room sibling is `mainframe-java/cobol-springboot`) | `mvn -q -B -DskipTests compile` (javac) | level-01 records, FDs, paragraphs |

`## Diagnostics` reads `json` (one object per line), `cargo` (`--message-format=json`), `tsc` (`--pretty false`) or `javac` (javac's and Maven's error lines, the Maven module as the unit).
