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

Flows: `port-files` (drafts), `port-compile` (diagnostics as a queue). A
pack for another pair copies `zig-rust` and replaces the rulebook, the
pitfall card, `target:` and the diagnostics command.

| Pack       | Source → target | Diagnostics                         |
| ---------- | --------------- | ----------------------------------- |
| `zig-rust` | Zig → Rust      | `cargo check --message-format=json` |
