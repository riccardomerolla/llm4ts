You are translating one COBOL source unit (a program or a copybook) to Java
on Spring Boot 3. Read this whole document before writing any code. The first
pass is a **draft** `.java` at the path the flow gives you, that captures the
logic faithfully; it does **not** need to compile. The compile pass makes it
compile module by module.

## Ground rules

- Same unit, same names, same order. The public class is named exactly as
  the file the flow asked for (Java requires it); paragraphs become private
  methods in the order they appear, named in camelCase after the paragraph
  (`2000-READ-INPUT` → `readInput2000`, the number kept as a suffix so the
  reviewer can diff the two files side by side). Data items keep their names
  in camelCase (`WS-TOTAL-AMT` → `wsTotalAmt`).
- A program is one `@Service` bean. Its `PROCEDURE DIVISION` is a public
  `run(...)` method whose parameters are the `ACCEPT`ed values and the
  `LINKAGE SECTION` items; its `WORKING-STORAGE` becomes fields on a private
  state class created per run, never static fields.
- A copybook is one class in the `legacy.copybook` package, ported once and
  imported by every program that `COPY`s it. Do not inline it.
- Numerics are exact. `PIC S9(7)V99 COMP-3` is `BigDecimal` with scale 2;
  `PIC 9(5)` is `long`; `PIC X(n)` is `String` with the width recorded in a
  comment. Money is never `double`.
- Files and SQL are repositories. An `FD` with `SELECT ... ASSIGN` becomes a
  JPA `@Entity` plus a Spring Data repository when the file is a keyed VSAM
  or DB table, or a dedicated reader class for a sequential flat file.
  `EXEC SQL` becomes a repository method; the host variables are its
  parameters. One `@Transactional` on `run` where the program `COMMIT`s at
  the end; explicit boundaries where it commits mid-way.
- `EXEC CICS` is the online boundary: `SEND MAP` / `RECEIVE MAP` become a
  request and response record on a `@RestController` that calls the service;
  `LINK` / `XCTL` become a call to the other program's service bean.
- `DISPLAY` is a logger call at `info`; `DISPLAY` of an error is `warn`.
  `ACCEPT FROM DATE` is `LocalDate.now(clock)` with an injected `Clock`.
  `STOP RUN` is a `return`; `GOBACK` is a `return` from the program method.
- Leave `// TODO(port): <reason>` for anything you cannot translate
  confidently. Do not guess.
- Do not translate JCL, compile options, SORT control cards or `IDENTIFICATION
  DIVISION` metadata; note them as `// SKIPPED(port): <what>`.

## Type map

| COBOL                              | Java / Spring Boot                                  |
| ---------------------------------- | --------------------------------------------------- |
| `PIC X(n)`                         | `String` (width `n` noted; pad or trim on `MOVE`)   |
| `PIC 9(n)`                         | `long` (`int` when `n` ≤ 9 and the source never exceeds it) |
| `PIC S9(n)V9(m)`, `COMP-3`         | `BigDecimal` with scale `m`, `RoundingMode.DOWN` unless `ROUNDED` |
| `COMP` / `BINARY`                  | `int` or `long` by the PIC                          |
| level-01 record                    | a `record` when read-only after construction, else a class |
| `OCCURS n`                         | an array or `List` sized `n`; `OCCURS DEPENDING ON` → `List` |
| `REDEFINES`                        | a second view class with explicit conversion methods |
| 88-level condition name            | a `boolean` method on the owning record (`isActive()`) |
| `FD` + `SELECT`                    | `@Entity` + `JpaRepository`, or a flat-file reader   |
| `EXEC SQL`                         | a repository method or `JdbcTemplate` call           |
| `EXEC CICS SEND/RECEIVE MAP`       | `@RestController` request/response records           |
| `CALL 'PROG' USING ...`            | a call to `Prog.run(...)` on the injected bean       |
| `PERFORM para`                     | a method call                                        |
| `PERFORM para THRU other`          | calls to each paragraph in source order, in a method named after the range |
| `PERFORM ... UNTIL cond`           | `while (!cond) { … }` (test before) or `do { … } while` (`WITH TEST AFTER`) |
| `PERFORM VARYING`                  | a `for` loop                                          |
| `EVALUATE`                         | `switch` with pattern matching, or an `if` chain for `EVALUATE TRUE` |
| `GO TO`                            | structured flow with a `// PORTED: GO TO` note        |
| `STRING` / `UNSTRING`              | `StringBuilder` / `split` with the delimiters written out |
| `INSPECT ... TALLYING/REPLACING`   | explicit counting / `replace`                          |
| `SORT` / `MERGE`                   | `Comparator` on a `List`, or a stream `sorted`         |
| `DISPLAY` / `ACCEPT`               | `log.info` / a method parameter                        |

## Idiom map

- A `MOVE` between items of different widths truncates on the right for
  alphanumerics and on the left for numerics; write the truncation out
  (`substring`, `remainder`) where the source relies on it, and say so.
- `ON SIZE ERROR` is an explicit range check before the assignment.
- `ADD 1 TO WS-COUNT` is `wsCount++` only when the PIC cannot overflow;
  otherwise the modulus the PIC implies.
- A paragraph that is both `PERFORM`ed and fallen into is split: the
  fall-through becomes an explicit call at the end of the preceding method.
- Dates `PIC 9(6)` `YYMMDD` become `LocalDate` with the century rule the
  program used, written in one place.
- `FILE STATUS` checks become typed exceptions on the reader or repository.

## Output format

End the file with the trailer the flow reads:

```java
// PORT STATUS
// source: <path>.cbl
// confidence: high | medium | low
// todos: <count of TODO(port)>
// notes: <one line>
```
