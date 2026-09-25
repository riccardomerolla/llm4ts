# REST API style guide (soap-ace default)

The design step treats every rule here as a hard constraint and the design
judge scores against it. A bank-specific guide replaces this file by
shipping a project-tier copy of the kit
(`.llm4ts/kits/soap-ace/packs/ace12-rest/api-style.md`).

## Resources and paths

- Resources are plural nouns in kebab-case: `/accounts`, `/credit-transfers`.
- Identifiers are path segments: `/accounts/{accountId}`. An IBAN used as an
  identifier is still an opaque path parameter.
- Sub-collections only for true containment:
  `/accounts/{accountId}/movements`.
- Actions that are not CRUD are sub-resources named by the resulting state,
  POSTed: `/credit-transfers/{id}/confirmation`, `/credit-transfers/{id}/revocation`.
- Versioning in the path: `/v1/...`. Breaking changes need a new version.

## Methods

- `GET` only for operations classified `read`; it never changes state.
- `POST` creates or triggers; `PUT` replaces; `PATCH` (JSON Merge Patch) for
  partial updates; `DELETE` removes.
- Creating `POST`s return `201` with a `Location` header.

## Payloads

- JSON with camelCase property names in English; SOAP names are mapped, not
  carried over (`dataContabile` → `bookingDate`).
- No wrapper objects that only mirror a SOAP element; no `esito` envelope in
  successful responses: success is the HTTP status.
- Dates are ISO 8601 (`2026-09-25`), timestamps ISO 8601 with offset.
- Amounts are `{ "amount": "1234.56", "currency": "EUR" }`: the amount is a
  decimal string, the currency ISO 4217.
- Enumerations are UPPER_SNAKE_CASE strings; values are mapped to English
  when the meaning is clear, otherwise kept and documented.
- Absent optional values are omitted, not `null`, unless `null` carries meaning.

## Errors

- Errors are RFC 9457 problem details (`application/problem+json`) with
  `type`, `title`, `status`, `detail`, and a stable machine-readable `code`.
- SOAP faults and `esito` KO codes map to statuses by meaning: validation →
  `400`/`422`, not found → `404`, state conflict → `409`, authorization →
  `403`, backend unavailable → `503`, anything unmapped → `502`.
- Backend codes are kept in the problem's `code`, never exposed as the HTTP
  status or as free text only.

## Collections

- Lists are wrapped: `{ "items": [...], "page": {...} }`.
- Pagination follows what the SOAP service actually does, as observed in the
  samples: page-number pagination (`page`, `size`, `totalItems` when known)
  or cursor pagination (`next` cursor) — never both on one resource.
- Filters are query parameters named after the response properties they
  filter (`?status=ACTIVE`, `?bookingDateFrom=...&bookingDateTo=...`).

## Traceability

- Every endpoint names the SOAP operation(s) it is built from, and every
  property names its XSD path, in the design document.
- A SOAP operation not exposed is listed as deliberately excluded, with the
  reason.
