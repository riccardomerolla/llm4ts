---
title: COBOL → Java/Spring Boot pitfalls — alike on the page, different at runtime
matches: .
tags: port, cobol, java, spring-boot
---
1. **Decimal scale.** `PIC S9(7)V99 COMP-3` has an implied point: `1234567.89`
   is stored as nine digits. A `double` loses cents; a `BigDecimal` without
   `setScale(2)` prints `1234567.9`.
2. **Truncation on MOVE.** Moving `PIC X(10)` into `PIC X(5)` keeps the left
   five characters; moving `PIC 9(5)` into `PIC 9(3)` keeps the right three
   digits. Java assignment keeps everything.
3. **Padding.** An alphanumeric field is space-padded to its width, so
   `"ABC" = "ABC  "` is true in COBOL and false in Java. Trim or pad at the
   boundary, in one place.
4. **Signed overpunch.** `PIC S9(3)` in display format carries the sign in
   the last byte (`12}` is `-120`). Parse it; never `Long.parseLong` the raw
   bytes.
5. **PERFORM THRU and fall-through.** Control falls into the next paragraph
   unless something stops it; a `PERFORM A THRU C` runs `B` too. A method per
   paragraph needs the range written out.
6. **GO TO out of a PERFORM.** The paragraph's exit point moves. Flatten with
   care, and say which exit the source used.
7. **REDEFINES.** Two layouts over the same bytes; writing one view changes
   the other. Two Java fields are two values; make the conversion explicit.
8. **OCCURS DEPENDING ON.** The table's length is another field's value at
   that moment; a fixed array hides out-of-range reads the source tolerated.
9. **88-levels and VALUE.** A condition name tests the parent's current
   value; `SET name TO TRUE` writes the first `VALUE`. Keep both directions.
10. **Zero-based indexing.** COBOL subscripts start at 1. Every `OCCURS`
    access shifts by one.
11. **ROUNDED and ON SIZE ERROR.** `COMPUTE` truncates by default and
    rounds only with `ROUNDED`; `RoundingMode.HALF_UP` is not the default.
12. **Dates.** `YYMMDD` with a century window, `ACCEPT FROM DATE` in local
    time: pin the rule and the clock.
13. **Sequential file state.** `READ ... AT END` and `FILE STATUS` codes are
    the control flow; a reader that throws on end-of-file changes it.
