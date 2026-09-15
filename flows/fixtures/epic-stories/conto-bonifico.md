# Epic: conto-bonifico

Add the retail customer's current account (Conto) with balance and movements, and wire transfers (Bonifico) with beneficiary, review, SCA confirmation, and history.

## Waves

1. accounts-contract, payments-contract, iban-field
2. conto-overview, conto-movimenti, bonifico-form, bonifici-list
3. home

## Stories

The expected split of the demo epic against the internet-banking portal fixture (`examples/internet-banking/portal`): two contract stories and one shared-kit story first, four screens under the concurrency cap, then the fan-in that owns the composition point. The block below is the source of truth; the flow's live generator is prompted with the same epic sentence.

## Plan block

```json storyplan
{
  "epicId": "conto-bonifico",
  "epic": "Add the retail customer's current account (Conto) with balance and movements, and wire transfers (Bonifico) with beneficiary, review, SCA confirmation, and history.",
  "stories": [
    {
      "id": "accounts-contract",
      "title": "Accounts domain contract and fake routes",
      "description": "Declare the Accounts HttpApi in src/contracts/accounts.ts: list the customer's current accounts (id, IBAN, label, balance in cents, available balance), one account's detail, and its movements as a cursor-paged list (date, description, amount in cents, running balance, category) whose optional cursor is the endpoint's `query` schema (HttpApiEndpoint's query option, called as client.accounts.movements({ params: { accountId }, query: { cursor } })); the fake reads it from the request query string. Implement src/contracts/accounts.fake.ts with deterministic fixture data for customer C-000123 (two accounts, at least 30 movements on the first), a reset function, and the exported accountsDomain. Run pnpm openapi and commit contracts/openapi/accounts.json. Follow src/contracts/profile.ts and profile.fake.ts exactly. Add src/contracts/accounts.test.ts covering the fake routes through the typed client: list, detail, and a page of movements.",
      "dependsOn": [],
      "owned": [
        "src/contracts/accounts.ts",
        "src/contracts/accounts.fake.ts",
        "contracts/openapi/accounts.json",
        "src/contracts/accounts.test.ts"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts/profile.ts",
        "src/contracts/profile.fake.ts",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "accountsDomain from src/contracts/accounts.fake.ts",
        "client.accounts.list()",
        "client.accounts.get({ params: { accountId } })",
        "client.accounts.movements({ params: { accountId }, query: { cursor } })",
        "src/contracts/accounts.test.ts"
      ]
    },
    {
      "id": "payments-contract",
      "title": "Payments domain contract and stateful fake routes",
      "description": "Declare the Payments HttpApi in src/contracts/payments.ts: list saved beneficiaries (name, IBAN), create a transfer from a payload with exactly these fields: fromAccountId as a plain string (it carries an Accounts domain account id, but this contract must not import anything from accounts.ts — the two contracts are independent), beneficiary as either { beneficiaryId } for a saved one or { name, iban } typed by the customer, amountCents, description, executionDate (ISO date), returning a pending transfer with an id, confirm a transfer with a six-digit SCA code: TransferState is exactly \"pending\" | \"confirmed\" | \"refused\"; any six-digit code other than 000000 moves the transfer to confirmed, the code 000000 moves it to refused and returns the refused transfer (HTTP 200, not an error), and a code that is not six digits is UnprocessableEntity; list transfers newest first with their state, and get one transfer. Implement src/contracts/payments.fake.ts with an in-memory store per page session so a created then confirmed transfer appears in the list, a reset function, and the exported paymentsDomain. Run pnpm openapi and commit contracts/openapi/payments.json. Follow src/contracts/profile.ts and profile.fake.ts exactly. Add src/contracts/payments.test.ts covering the fake routes through the typed client: create then confirm then list, and the refused code 000000.",
      "dependsOn": [],
      "owned": [
        "src/contracts/payments.ts",
        "src/contracts/payments.fake.ts",
        "contracts/openapi/payments.json",
        "src/contracts/payments.test.ts"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts/profile.ts",
        "src/contracts/profile.fake.ts",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "paymentsDomain from src/contracts/payments.fake.ts",
        "client.payments.beneficiaries()",
        "client.payments.create({ payload })",
        "client.payments.confirm({ params: { transferId }, payload: { code } })",
        "client.payments.list()",
        "client.payments.get({ params: { transferId } })",
        "src/contracts/payments.test.ts",
        "TransferState = \"pending\" | \"confirmed\" | \"refused\""
      ]
    },
    {
      "id": "iban-field",
      "title": "IBAN input component in the kit",
      "description": "Add src/kit/iban-field.tsx exporting IbanField (a labelled input that formats the IBAN in groups of four as the customer types, keeps the compact value, and reports validity) and isValidIban (the mod-97 check over the ISO 13616 alphabet). Add src/kit/iban-field.test.tsx covering formatting and valid and invalid IBANs, using the existing Field component and theme classes only.",
      "dependsOn": [],
      "owned": [
        "src/kit/iban-field.tsx",
        "src/kit/iban-field.test.tsx"
      ],
      "sharedReadOnly": [
        "src/kit/components.tsx",
        "src/kit/theme.css",
        "src/kit/i18n.tsx",
        "src/kit/format.ts",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "IbanField and isValidIban from src/kit/iban-field.tsx"
      ]
    },
    {
      "id": "conto-overview",
      "title": "Conto: account overview screen",
      "description": "Add the feature src/features/conto/overview/ with messages.ts (English and Italian), route.tsx exporting contoOverviewFeature (id conto), and ContoScreen.tsx: an account picker across the customer's accounts, the balance and available balance as Figures, the IBAN and account details as KeyValues, loaded through accountsDomain. Add ContoScreen.test.tsx in the house style: rows and figures render in both languages against the fake transport.",
      "dependsOn": [
        "accounts-contract"
      ],
      "owned": [
        "src/features/conto/overview"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts",
        "src/features/profilo",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "contoOverviewFeature from src/features/conto/overview/route.tsx",
        "screen id conto"
      ]
    },
    {
      "id": "conto-movimenti",
      "title": "Conto: movements list with filter and CSV export",
      "description": "Add the feature src/features/conto/movimenti/ with messages.ts (English and Italian), route.tsx exporting contoMovimentiFeature (id movimenti), and MovimentiScreen.tsx: the selected account's movements as a DataTable paged with usePages and LoadMore, a SelectFilter by category, and a CSV export through downloadCsv, loaded through accountsDomain. Add MovimentiScreen.test.tsx in the house style: rows render, the filter narrows them, the next page loads.",
      "dependsOn": [
        "accounts-contract"
      ],
      "owned": [
        "src/features/conto/movimenti"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts",
        "src/features/profilo",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "contoMovimentiFeature from src/features/conto/movimenti/route.tsx",
        "screen id movimenti"
      ]
    },
    {
      "id": "bonifico-form",
      "title": "Bonifico: new transfer with review, SCA confirmation and outcome",
      "description": "Add the feature src/features/bonifico/nuovo/ with messages.ts (English and Italian), route.tsx exporting bonificoNuovoFeature (id bonifico), and BonificoScreen.tsx: a form (from account chosen among the customer's accounts loaded through accountsDomain from src/contracts/accounts.fake.ts, beneficiary picked from saved beneficiaries or typed with IbanField, amount with parseEuro, description, execution date) validated by a pure function, a review step, a six-digit SCA code step calling client.payments.confirm, and an outcome panel for confirmed and refused, all through paymentsDomain and useAction. Add BonificoScreen.test.tsx in the house style: validation blocks a bad submit, a good transfer reaches the fake and is confirmed, code 000000 shows the refusal.",
      "dependsOn": [
        "payments-contract",
        "iban-field",
        "accounts-contract"
      ],
      "owned": [
        "src/features/bonifico/nuovo"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts",
        "src/features/profilo",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "bonificoNuovoFeature from src/features/bonifico/nuovo/route.tsx",
        "screen id bonifico"
      ]
    },
    {
      "id": "bonifici-list",
      "title": "Bonifico: transfer history with state badges and detail",
      "description": "Add the feature src/features/bonifico/elenco/ with messages.ts (English and Italian), route.tsx exporting bonificiElencoFeature (id bonifici), and BonificiScreen.tsx: the customer's transfers newest first as a DataTable with a StateBadge per state (pending, confirmed, refused mapped to tones) and a detail panel for the selected transfer, through paymentsDomain. Add BonificiScreen.test.tsx in the house style: rows render with translated states in both languages, selecting a row shows its detail.",
      "dependsOn": [
        "payments-contract"
      ],
      "owned": [
        "src/features/bonifico/elenco"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts",
        "src/features/profilo",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "bonificiElencoFeature from src/features/bonifico/elenco/route.tsx",
        "screen id bonifici"
      ]
    },
    {
      "id": "home",
      "title": "Home dashboard and the composition point",
      "description": "Replace the placeholder src/features/home/ with a dashboard: the first account's balance as a Figure, the last five movements, a quick action navigating to the transfer form with useNavigate, and the three most recent transfers, through accountsDomain and paymentsDomain. Rewrite src/App.tsx so the feature list is home, conto, movimenti, bonifico, bonifici, profilo, in that order. Add HomeScreen.test.tsx in the house style: the figures and lists render, the quick action navigates.",
      "dependsOn": [
        "conto-overview",
        "conto-movimenti",
        "bonifico-form",
        "bonifici-list"
      ],
      "owned": [
        "src/features/home",
        "src/App.tsx"
      ],
      "sharedReadOnly": [
        "src/kit",
        "src/contracts",
        "src/features/conto",
        "src/features/bonifico",
        "src/features/profilo",
        "CONTRIBUTING.md"
      ],
      "provides": [
        "the composed application with every screen reachable from the shell"
      ]
    }
  ]
}
```
