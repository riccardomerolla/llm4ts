---
files: \.java$
---
Review a Java draft against the rulebook as a port reviewer would, with the
COBOL source in mind: the diff is the draft. Report as findings: a paragraph,
data item or 88-level the source has that the draft lacks; a `double` or
`float` holding a `COMP-3`, money or quantity field; a `BigDecimal` whose
scale differs from the PIC; a `MOVE` truncation or padding the source relied
on that the draft assumes away; a `GO TO` turned into a state variable loop
when the flow was structured; a `PERFORM THRU` range that skips a paragraph;
file or SQL access outside a repository or reader; a program that commits
with no `@Transactional` boundary; `WORKING-STORAGE` turned into static
fields; a copybook inlined instead of imported; a guessed translation where a
`TODO(port)` was honest. Do not report imports or beans that cannot resolve
yet: the compile pass owns those.
