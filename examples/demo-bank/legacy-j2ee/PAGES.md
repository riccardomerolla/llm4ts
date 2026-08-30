# DemoBank Legacy Portal - Page Inventory

Synthetic legacy J2EE fixture for the bank-conversion PoC demo. Authored
from scratch; no real bank code or branding. This file is the answer key
for judging survey/extract quality: it lists every page, its live/dead
status, and the page -> endpoint -> ESB-service mapping.

All JSPs live under `src/main/webapp/`. Java sources live under
`src/main/java/com/demobank/legacy/` (`web/` controllers, `dto/` data
classes, `esb/` fake ESB service wrappers). The app is not runnable and is
not meant to be; it only has to read as authentic mid-2000s J2EE.

## Hero pages

The three pages the workshop converts end to end. Each exercises a
different legacy mix on purpose:

| #   | Page                                                                | Mix it exercises                                                                                                                                                                         |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `accountOverview.jsp`                                               | Server-rendered JSTL table from a request-scoped model, plus a jQuery `$.ajax` GET that refreshes balances as JSON. Read-only.                                                           |
| 2   | `beneficiaryList.jsp` + `beneficiaryEdit.jsp`                       | CRUD list + form. Client-side jQuery validation (inline + shared `validate.js`) AND server-side validation in the servlet; the two rule sets deliberately overlap but are not identical. |
| 3   | `transferStep1.jsp` -> `transferStep2.jsp` -> `transferConfirm.jsp` | Multi-step wizard keeping a `TransferDraft` in `HttpSession` across steps; scriptlets mixed with JSTL. The hardest extraction case.                                                      |

## Full page list

| Page                  | Status        | Notes                                                                                                                                                   |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login.jsp`           | live          | Welcome page (see `web.xml` welcome-file). Filler shell; form posts to a servlet that does not exist on purpose (`j_security_check` style legacy stub). |
| `dashboard.jsp`       | live          | Filler landing page after login; scriptlet date banner.                                                                                                 |
| `accountOverview.jsp` | live (HERO 1) | Served by `AccountOverviewServlet` forward.                                                                                                             |
| `beneficiaryList.jsp` | live (HERO 2) | Served by `BeneficiaryServlet` forward.                                                                                                                 |
| `beneficiaryEdit.jsp` | live (HERO 2) | Add/edit form; posts back to `BeneficiaryServlet`.                                                                                                      |
| `transferStep1.jsp`   | live (HERO 3) | Amount + beneficiary pick.                                                                                                                              |
| `transferStep2.jsp`   | live (HERO 3) | Review screen; data comes from session draft.                                                                                                           |
| `transferConfirm.jsp` | live (HERO 3) | Result screen; shows ESB reference number.                                                                                                              |
| `settings.jsp`        | live          | Filler; scriptlet-heavy preference toggles, nothing wired.                                                                                              |
| `profile.jsp`         | live          | Filler; static customer data with scriptlets.                                                                                                           |
| `messages.jsp`        | live          | Filler; inbox-style static table.                                                                                                                       |
| `help.jsp`            | live          | Filler; static FAQ.                                                                                                                                     |
| `oldTransfer.jsp`     | DEAD          | Pre-wizard single-page transfer. Not in nav, not in `web.xml`, nothing links to it.                                                                     |
| `promoQ3.jsp`         | DEAD          | Expired Q3 2011 campaign page. Unreferenced.                                                                                                            |
| `testHarness.jsp`     | DEAD          | Developer scratch page hitting endpoints by hand. Unreferenced.                                                                                         |
| `header.jsp`          | fragment      | Included via `<jsp:include>` from every page.                                                                                                           |
| `nav.jsp`             | fragment      | Included from `header.jsp`; the nav link set defines "referenced".                                                                                      |
| `footer.jsp`          | fragment      | Included via `<jsp:include>` from every page.                                                                                                           |

Live pages: 12. Dead pages: 3. Fragments: 3. Total JSP files: 18.

## Page -> endpoint -> ESB service (answer key)

| Page                  | HTTP endpoint (`web.xml` url-pattern)                                            | Controller               | ESB wrapper                              | ESB service id   |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------- | ---------------- |
| `accountOverview.jsp` | `GET /accountOverview` (HTML), `GET /accountOverview?fmt=json` (AJAX refresh)    | `AccountOverviewServlet` | `EsbAcctListService`                     | `ESB_ACCT_LIST`  |
| `beneficiaryList.jsp` | `GET /beneficiary` (list), `GET /beneficiary?action=delete&benfId=..`            | `BeneficiaryServlet`     | `EsbBenfListService`                     | `ESB_BENF_LIST`  |
| `beneficiaryEdit.jsp` | `GET /beneficiary?action=edit&benfId=..` (load form), `POST /beneficiary` (save) | `BeneficiaryServlet`     | `EsbBenfMaintService`                    | `ESB_BENF_MAINT` |
| `transferStep1.jsp`   | `GET /transfer` (start), `POST /transfer` with `step=1`                          | `TransferServlet`        | `EsbBenfListService` (beneficiary combo) | `ESB_BENF_LIST`  |
| `transferStep2.jsp`   | `POST /transfer` with `step=2` (validate draft)                                  | `TransferServlet`        | `EsbTrfValidateService`                  | `ESB_TRF_VAL`    |
| `transferConfirm.jsp` | `POST /transfer` with `step=3` (execute)                                         | `TransferServlet`        | `EsbTrfExecService`                      | `ESB_TRF_EXEC`   |
| dead pages            | none                                                                             | none                     | none                                     | none             |

DTOs: `AcctOvwDTO` (hero 1), `BenfDTO` (hero 2), `TrfDTO` + session-held
`TransferDraft` (hero 3). Field names use period-typical abbreviations
(`acctNo`, `curBal`, `avlBal`, `ccyCd`, `benfNm`, `trfAmt`, ...) so the
anti-corruption renaming in a Page Spec has something to bite on.

All data is fictional: EUR accounts, fake IBAN-like numbers in the form
`IT00 DEMO 0000 ...`, customer "MARIO BIANCHI" / customer id `CUST0042`.
