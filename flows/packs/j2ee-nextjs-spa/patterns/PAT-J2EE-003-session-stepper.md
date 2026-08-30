---
match: HttpSession|session\.setAttribute|session\.getAttribute
---
An HttpSession-carried multi-step flow becomes explicit client state driven by
the destination Stepper: one state object typed after the spec's sessionState
(the legacy draft DTO, domain-renamed), owned by the flow's top-level page,
passed down per step. Refresh/back semantics are explicit — the legacy app got
them free from the session; the SPA must decide and the spec's navigation
section says what to preserve. Never scatter the draft across components.
