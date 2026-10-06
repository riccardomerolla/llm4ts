---
title: Scala/ZIO → TypeScript/Effect pitfalls — alike on the page, different at runtime
matches: .
tags: port, scala, zio, effect
---
1. **Type parameter order.** `ZIO[R, E, A]` is `Effect<A, E, R>`: a mechanical
   copy of the parameter list silently swaps the requirement and the value.
2. **Equality.** `==` on a case class compares structure; `===` on an object
   compares identity. Use `Equal.equals` or compare fields.
3. **Laziness.** A Scala `lazy val` or by-name parameter evaluates once or on
   demand; a TypeScript expression evaluates where it is written. Wrap in a
   thunk or `Effect.suspend`.
4. **Option.get and head.** Scala throws; TypeScript yields `undefined` and
   carries on. Make the absence a typed failure.
5. **Integer division and overflow.** Scala `Int` wraps at 32 bits and `/`
   truncates; JavaScript numbers are doubles. Use `Math.trunc` and check
   ranges where the source relied on `Int`.
6. **String formatting and `toString`.** A Scala `toString` on a case class
   prints its fields; the TypeScript default prints `[object Object]`.
7. **Implicit conversions and givens.** They vanish in the port; every one is
   an explicit call or a service the draft must name.
