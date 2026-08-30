---
match: \$\(['"]#|validate\.js|onsubmit=
---
jQuery/inline validation becomes the house Form component's validation map:
one entry per spec rule, message text VERBATIM, evaluated in the spec's order
(first-failure-wins). Where the legacy client and server rules diverged, the
spec's per-rule enforcedAt says which set is contract — implement the union,
flag any contradiction as an open question rather than silently choosing.
