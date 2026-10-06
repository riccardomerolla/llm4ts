---
title: Zig → Rust pitfalls — syntactically alike, semantically different
matches: .
tags: port, zig, rust
---
The regressions the Bun port shipped (May 2026) were code that reads the same
in both languages and does something different. Check for each:

1. **Asserts with side effects.** Zig's `std.debug.assert(f())` always calls
   `f` in every build; Rust's `debug_assert!(f())` erases the call in release.
   Keep the call, assert the result.
2. **Slice casts on odd lengths.** The Zig helper truncated a `[]u8` to the
   element size; `bytemuck::cast_slice` panics on a remainder. Truncate first.
3. **Bounds checks kept.** Zig ReleaseFast dropped them; Rust release keeps
   them, so a latent off-by-one the Zig never hit is reachable. Treat an
   index panic as a real bug in the source's logic, not as noise.
4. **Comptime format strings.** `comptime` string assembly happened once at
   build time; a runtime `format!` per call changes both cost and, where
   markers are rewritten, the bytes. Use a macro or a `const`.
5. **Placeholder constants.** A value "to be threaded through later" becomes
   a different limit in the port. Every `TODO(port)` placeholder is listed in
   the trailer and closed in the compile pass.
