---
match: Esb[A-Za-z]+Service|ESB_[A-Z_]+
---
Every EsbXxxService wrapper the servlet called becomes one port operation in
the page's anti-corruption contract: the OpenAPI operation carries the domain
name, the port interface mirrors it, and the mock adapter returns
contract-shaped fixtures. The ESB routine name lands in the contract's
description (the future B4F team's pointer), never in code identifiers. If the
servlet combined two ESB calls, the port exposes the page's need (one
operation), and the composition note goes in the contract description.
