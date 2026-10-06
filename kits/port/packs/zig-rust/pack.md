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

## Review rules

Every `unsafe` block carries a `// SAFETY: <why>` comment, and no new
`unsafe` appears outside FFI. A `TODO(port): <reason>` marker is the right
answer where the translation is uncertain; a guess is not. `anyhow`,
`tokio`, `rayon`, `async fn` and `std::fs`/`std::net`/`std::process` are
findings: the rulebook forbids them.
