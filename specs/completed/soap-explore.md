# soap-ace: `soap-explore`, one command from WSDL to design draft

New flow `kits/soap-ace/flows/soap-explore.ts`: given a WSDL (file or URL)
it runs discovery, writes a request for every operation, calls the read
operations once in producer-first order with values chained from earlier
responses, analyses the evidence, writes the 1:1 mapping, and drafts the
REST design. It stops only where a person decides and writes one report,
`explore.md`, listing each gap with the command that closes it.

Driver: the four `soap-*` flows expose every step as its own command
(`discover`, `init` per operation, `call` per request, `analyse`,
`mapping`, `design`, `check`). That is right for iterating one operation
and wrong for the first hour with a new service. The expected UX is
SoapUI/ReadyAPI's: point it at a WSDL and get every operation with a
request and a response. Nothing here is a new capability. The flow
orchestrates the existing library, so each step's rules (masking, call
policy, validation, approval files) stay where they are.

Builds on `specs/pending/soap-ace-kit.md`; its decisions still hold.

## Decisions (agreed 2026-09-28)

| Decision     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry point  | `llm4ts run soap-explore --repo . <wsdl path or URL>`. With no task text it continues from the only discovered service (or `LLM4TS_SOAP_SERVICE`) without rediscovering. Fetch auth is as in `soap-discover`: the fetch side of `auth.json` for `LLM4TS_SOAP_SERVICE`.                                                                                                                                                                                                                                                                                 |
| Resumable    | Every step skips what is done: an existing `operations.md`, request file, exchange, or `api-design.md` is kept. A rerun continues where the last one stopped. `--refresh` calls the probed operations again. The other `soap-*` flows keep working on the same files.                                                                                                                                                                                                                                                                                  |
| Requests     | Each operation without a request gets `samples/<op>/happy-path.request.yaml`, the existing skeleton (`renderRequestFile`) seeded with values. A file explore writes starts with a marker line and stays explore-owned (regenerated on a probe) until the user deletes that line.                                                                                                                                                                                                                                                                       |
| Probe gate   | Only read operations are called, never a mutating or unclassified one. With `operations.md` **confirmed**, its `read` class decides, in any environment. **Before** confirmation, an operation is probed provisionally only when the environment is `dev` or `test` (never `uat`), `operations.md` still lists it as `read`, the name heuristic says `read`, **and** the `Judgment` seat says `read` with an `act` decision. Without a judgment seat, nothing is probed until `operations.md` is confirmed. The per-operation reason is in the report. |
| Auth profile | No `auth.json` means no probe. The report prints the minimal profile (`{"environment": "test"}`); explore never writes `auth.json`, because the environment label is the user's declaration.                                                                                                                                                                                                                                                                                                                                                           |
| Chaining     | Calls run producer-first: A precedes B when a leaf field name of A's response is a required input field name of B (Kahn order, ties and cycles broken by catalog order). The first value per field name from this run's responses seeds B's request. **Live values stay in memory**: the call sends the unmasked value, while the request file on disk carries the masked value (identical for non-personal fields) and a comment naming the chained fields. Personal values are never written unmasked.                                               |
| Calls        | Through `callOperation`, unchanged rules: validation before sending, masking, auth-stripped exchanges. It gains an in-memory request override (the chained body) and returns the unmasked response payload in memory only. A failed call is recorded in the report and does not stop the run.                                                                                                                                                                                                                                                          |
| Evidence     | `analysis/<op>.md` for every operation (`writeAnalyses`), then `design/mapping.json` + `.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Design draft | On by default, `--no-design` skips it. It needs at least one exchange and no existing `api-design.md`. The reasoning seat (`LLM4TS_REASONER`, default `claude`) drafts, `check` runs, and when errors remain one `revise` round follows. An existing design is only checked. A drafting failure is reported, not fatal. `Status: approved` stays a human sign-off; `openapi` and `soap-epic` stay separate commands.                                                                                                                                   |
| Report       | `.llm4ts/soap/<service>/explore.md`, regenerated every run. It has one row per operation (class, probe decision and reason, request, outcome, schema findings), the chain (consumer ← producer: fields), the design state, and "Next" with exact commands.                                                                                                                                                                                                                                                                                             |
| Visual view  | Not in v1. A static `explore.html` over the same masked files is a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Tasks

- [x] `lib/soap/Explore.ts`: probe decisions, producer-first order, chained
      seeds (live and masked), explore-owned request files, the explore
      pipeline over a `SoapTransportShape`, and the report.
- [x] `Call.ts`: optional in-memory request, unmasked response payload in
      the result (never persisted).
- [x] `soap-explore` flow: discover → explore pipeline → analyses and mapping
      → optional design draft/check/revise → report.
- [x] Tests on `demo-bank-soap` with the stub transport: probe gating
      (unconfirmed without judgment, uat, confirmed, mutating never), chain
      order and seeding, no unmasked chained personal value on disk,
      resumability and `--refresh`, report content.
- [x] Docs: kit README quick start leads with `soap-explore`; fixture runbook.

## Non-goals

A recording proxy; calling mutating operations; approving anything on the
user's behalf; the HTML workbench; chaining across runs with live values
(a rerun without `--refresh` only has the masked values on disk).
