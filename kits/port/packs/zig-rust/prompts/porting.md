You are translating one Zig file to Rust. Read this whole document before
writing any code. The goal of the first pass is a **draft** `.rs` beside the
`.zig`, same basename, that captures the logic faithfully; it does **not**
need to compile. The compile pass makes it compile crate by crate.

## Ground rules

- Write the `.rs` in the same directory as the `.zig`, same basename. Do not
  invent crate layouts; put the file where the source is.
- Match the Zig's structure: same `fn` names (snake_case), same field order,
  same control flow. Reviewers diff `.zig` and `.rs` side by side.
- No `tokio`, `rayon`, `hyper`, `async-trait`, `futures`. No `std::fs`,
  `std::net`, `std::process`: the code base owns its event loop and
  syscalls. No `async fn`.
- `unsafe` is fine where the Zig was already unsafe. Annotate every block
  with `// SAFETY: <why>`.
- Leave `// TODO(port): <reason>` for anything you cannot translate
  confidently. Do not guess: flagging is better than wrong code.
- Leave `// PERF(port): <zig idiom>` wherever the Zig used a
  performance-specific idiom, for the profiling pass.
- Do not translate tests, build scripts or comptime-only helpers that exist
  to drive the Zig build; note them as `// SKIPPED(port): <what>`.

## Type map

| Zig                       | Rust                                  |
| ------------------------- | ------------------------------------- |
| `[]const u8`              | `&[u8]` (or `&str` only when the Zig guarantees UTF-8) |
| `[]u8` owned              | `Vec<u8>`                             |
| `?T`                      | `Option<T>`                           |
| `anyerror!T`, `E!T`       | `Result<T, Error>` with the crate's error enum, never `anyhow` |
| `*T`                      | `&mut T` or `*mut T` per the lifetime table |
| `*const T`                | `&T` or `*const T` per the lifetime table |
| `std.ArrayList(T)`        | `Vec<T>`                              |
| `std.StringHashMap(V)`    | `HashMap<Vec<u8>, V>` (the crate's hasher) |
| `comptime T: type`        | a generic parameter or a trait        |
| `switch` on tagged union  | `match` on an enum with data          |
| `defer`                   | a scope guard or `Drop`               |
| `errdefer`                | explicit cleanup on the `Err` path    |

## Idiom map

- Allocator parameters: delete them outside the AST crates; the Rust side
  allocates through the type's own methods.
- `std.debug.assert(expr)` where `expr` has side effects: keep the side
  effect, assert the value (`debug_assert!` erases the call).
- Casting slices (`@ptrCast`, `@alignCast`) on odd lengths: the Zig helper
  truncated; `bytemuck::cast_slice` panics. Truncate explicitly.
- Bounds checks the Zig dropped in ReleaseFast stay in Rust; do not
  "optimise" with `get_unchecked` in the draft.
- `comptime` format strings and string builders become macros or
  `const` arrays, never runtime strings assembled per call.

## Output format

End the file with the trailer the flow reads:

```rust
// PORT STATUS
// source: <path>.zig
// confidence: high | medium | low
// todos: <count of TODO(port)>
// notes: <one line>
```

`confidence: low` means "the logic is probably wrong; re-read the Zig in the
compile pass".
