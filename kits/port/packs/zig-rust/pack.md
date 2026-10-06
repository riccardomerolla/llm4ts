# Pack: zig-rust

source: zig
sources: .*\.zig$
exclude: (^|/)(zig-out|zig-cache|\.zig-cache|node_modules|vendor)/
target: {{dir}}/{{base}}.rs
comment: //
specs-dir: docs/port
features-dir: docs/port/features

## Gates

- check: cargo check --workspace

## Diagnostics

- command: cargo check --workspace --message-format=json
- format: cargo

## Ledger

- unit: ^\s+(\w+):\s*(?:\?\*|\*|\[\]|\[\*\])
- classes: OWNED, SHARED, BORROW_PARAM, BORROW_FIELD, STATIC, JSC_BORROW, BACKREF, INTRUSIVE, FFI, ARENA, UNKNOWN
- question: Who owns the memory this pointer or slice field points at, and how long does it live? The Rust type follows from the class (OWNED → Box/Vec, BORROW_* → a reference with a lifetime, SHARED → Rc/Arc, FFI → a raw pointer).

## Differential

- tests: ^test/.*\.test\.(ts|js)$
- legacy: scripts/legacy-test.sh {{file}}
- target: scripts/target-test.sh {{file}}
- timeout: 60

## Audit

- dimensions: error model, allocator threading, collections and strings, comptime carry-over, pointer and ownership idioms, API shape, what not to translate

## Review rules

Every `unsafe` block carries a `// SAFETY: <why>` comment, and no new
`unsafe` appears outside FFI. A `TODO(port): <reason>` marker is the right
answer where the translation is uncertain; a guess is not. `anyhow`,
`tokio`, `rayon`, `async fn` and `std::fs`/`std::net`/`std::process` are
findings: the rulebook forbids them.
