# Demo fixture: synthetic legacy J2EE bank app

Author a realistic synthetic J2EE web application that serves as the legacy
input repository for the bank-conversion PoC demo (see
`specs/pending/j2ee-demo-workshop-runbook.md` for the demo it feeds). No
real client code is involved; the fixture must be demoable anywhere with no
NDA concerns.

Driver: PoC demo for a bank prospect — J2EE (JSP + jQuery + served JS)
frontend calling REST services that wrap ESB/Cobol business logic. The
survey/extract phases run against this repo, so it must be messy enough to
make the inventory story credible and structured enough that extraction
succeeds.

## Decisions (agreed 2026-08-30)

| Decision   | Choice                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realism    | Synthetic repo authored by us; no open-source stand-in, no client code.                                                                                                                                                                                 |
| Location   | Source tree under `examples/demo-bank/legacy-j2ee/`; a seed script materializes it as a standalone git repo in a work directory (the flows need a real repo root, not a subdirectory of llm4ts).                                                        |
| Size       | 15–20 JSP pages total, including nav shells, `<jsp:include>` fragments, and 2–3 dead/unreferenced pages — realistic mess for the survey to triage.                                                                                                      |
| Hero pages | (1) Account overview — read-only list, one GET. (2) Beneficiary management — CRUD list + form, server-side validation. (3) Wire transfer — multi-step form with session state across steps and a confirmation screen.                                   |
| Backend    | Servlet/controller layer exposing REST-ish JSON endpoints whose implementations are obvious wrappers over fake "ESB services" (interfaces named after Cobol-ish routines, e.g. `ESB_ACCT_LIST`), so the extract phase can map page → API → ESB service. |

## Requirements

- JSP pages use the period-typical mix: scriptlets, JSTL, `<jsp:include>`
  headers/footers, jQuery `$.ajax` calls, some inline validation JS, some
  validation server-side only — the three hero pages must each exercise a
  different mix so Page Specs differ meaningfully.
- `web.xml` with `<url-pattern>` mappings (the existing `jsp-nextjs` pack
  coverage rules key on this) and form `action="..."` targets in JSPs.
- DTO classes for each hero page's data (legacy naming, e.g. `AcctOvwDTO`
  with abbreviated field names) so the anti-corruption renaming in the
  Page Spec has something to bite on.
- Wire transfer keeps a multi-step flow in `HttpSession` — the hardest
  extraction/conversion case and the workshop's finale.
- The app does NOT need to run; it must only read as authentic. No
  app-server build, no Maven wiring beyond a plausible `pom.xml` skeleton.
- Seed script (extend or mirror `examples/seed.sh`) copies the tree to a
  target directory, runs `git init`, and commits — deterministic, no
  network.

## Tasks

- [ ] Page inventory design note in the fixture root (`PAGES.md`): list of
      all pages, which are live/dead, which are the three hero pages, and
      the page → endpoint → ESB-service table (this doubles as the answer
      key for judging extraction quality).
- [ ] Shared shell: `header.jsp`, `footer.jsp`, `nav.jsp`, `web.xml`,
      `pom.xml` skeleton, static `js/` with jQuery and a shared
      `validate.js`.
- [ ] Hero page 1: account overview (JSP + controller + DTO + fake ESB
      wrapper).
- [ ] Hero page 2: beneficiary management (list JSP + form JSP + controller
      with server-side validation + DTOs + two fake ESB wrappers).
- [ ] Hero page 3: wire transfer (3-step JSP flow + session-carrying
      controller + confirmation + DTOs + fake ESB wrappers).
- [ ] Filler pages (~10): login shell, dashboard, settings, help, plus 2–3
      dead pages unreferenced from nav.
- [ ] Seed script that materializes the fixture as a standalone git repo.
- [ ] Smoke check in CI: seed script runs, produced repo contains the
      expected file set (deterministic test, no network).

## Non-goals

Runnable J2EE deployment, database schemas, authentication that works,
open-source code imports (license noise), and any content resembling a real
bank's code or branding.
