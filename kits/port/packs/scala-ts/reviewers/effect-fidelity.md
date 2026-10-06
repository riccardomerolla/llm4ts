---
files: \.ts$
---
Review a TypeScript draft against the rulebook as a port reviewer would, with
the Scala source in mind: the diff is the draft. Report as findings: a method,
field or case the source has that the draft lacks; `any`, an unchecked cast, a
namespace, or a global `Error` in an error channel; a service without a layer
where the source had a `ZLayer`; a relative import without a `.ts` extension;
a case class turned into a plain interface where a `Schema.Class` belongs;
`ZIO[R, E, A]` order kept as `Effect<R, E, A>`; a `for` comprehension turned
into nested callbacks where `Effect.gen` was the answer; a guessed translation
where a `TODO(port)` was honest. Do not report imports that cannot resolve
yet: the compile pass owns those.
