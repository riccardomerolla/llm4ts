Write Gherkin .feature files encoding the spec as executable user journeys —
these become the component tests of the converted page.

- One feature per screen/flow.
- User vocabulary, not servlet vocabulary: "When she submits a transfer of
  3000.00, Then she is asked to confirm", not "doPost forwards to confirm.jsp".
- Error messages are asserted VERBATIM — they are contract.
- Concrete values everywhere: real account numbers, amounts, statuses from the
  fixture data.
- Cover: the happy path, EVERY validation rule and its message (noting whether
  the legacy app enforced it client-side, server-side, or both), threshold
  boundaries, confirmation flows, and the state that must survive navigation
  (what the session or hidden fields carried).
