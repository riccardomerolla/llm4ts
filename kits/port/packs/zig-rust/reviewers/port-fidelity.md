---
files: \.rs$
---
Review a Rust draft against the rulebook as a port reviewer would, with the
Zig source in mind: the diff is the draft. Report as findings: a function,
field or branch the source has that the draft lacks (dropped logic); a
`pub fn deinit(&mut self)` where `impl Drop` is the rulebook's answer;
`anyhow::Error` or `Box<dyn Error>` where the crate's error enum belongs;
a bare `as` narrowing cast; an `unsafe` block without a `// SAFETY:` line;
`async fn`, `tokio`, `rayon`, `std::fs`, `std::net` or `std::process`; a
`debug_assert!` whose argument had a side effect in the source; a guessed
translation where a `TODO(port)` was the honest answer. Do not report imports
that cannot resolve yet or lifetimes: the compile pass owns those.
