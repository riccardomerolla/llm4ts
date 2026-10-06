# Pack: cobol-springboot-port

source: cobol
sources: .*\.(cbl|cob|cpy|CBL|COB|CPY)$
exclude: (^|/)(target|build|\.git|node_modules)/
target: src/main/java/legacy/{{dir}}/{{base}}.java
comment: //
specs-dir: docs/port
features-dir: docs/port/features

## Gates

- compile: mvn -q -B -DskipTests compile
- test: mvn -q -B test

## Diagnostics

- command: mvn -q -B -DskipTests compile
- format: javac

## Ledger

- unit: ^\s{0,7}(?:01|77)\s+([A-Z][A-Z0-9-]*)|^\s{0,7}FD\s+([A-Z][A-Z0-9-]*)|^\s{0,7}([A-Z0-9][A-Z0-9-]*)\s*(?:SECTION)?\.\s*$
- classes: RECORD, FILE, PARAGRAPH, SQL, CICS, COPYBOOK, REPORT, UTIL, UNKNOWN
- question: What does this COBOL unit become in a Spring Boot port? RECORD (a level-01 or 77 data item → a Java record or class with BigDecimal for numerics), FILE (an FD / SELECT → a JPA entity with a Spring Data repository, or a reader for a flat file), PARAGRAPH (a paragraph or section → a private method on the program's @Service), SQL (a paragraph whose body is EXEC SQL → a repository query), CICS (EXEC CICS send/receive → a controller endpoint or a service boundary), COPYBOOK (a shared record → a class in the copybook package, ported once), REPORT (a print layout → a formatter), UTIL (a pure routine).

## Differential

- tests: ^tests/.*\.(txt|dat|json)$
- legacy: scripts/legacy-run.sh {{file}}
- target: scripts/target-run.sh {{file}}
- timeout: 120

## Audit

- dimensions: data division and record layouts, PIC clauses and numeric semantics, files and embedded SQL, control flow (PERFORM, GO TO, fall-through), copybooks and shared records, batch versus online (CICS), transaction boundaries, test idioms, what not to translate

## Review rules

A `double` or `float` holding money, a quantity or any `COMP-3` field is a
finding: numerics are `BigDecimal` with the PIC's scale, or `long` for
unsigned integer PICs. A `MOVE` whose truncation or padding the source relied
on must be written out, not assumed. `GO TO` is flattened into structured
control flow with a `// PORTED: GO TO` note, never a `while (true)` with a
state variable unless the source was a state machine. Every file and SQL
access sits behind a Spring Data repository or a dedicated reader; every
program that commits has one `@Transactional` boundary. A paragraph the
source has that the draft lacks is a finding.
