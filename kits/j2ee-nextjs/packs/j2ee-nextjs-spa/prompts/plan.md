Derive the conversion task list for ONE page from its Page Spec. The
destination is an existing Next.js SPA with a design system, an AuthProvider,
and a port/adapter service convention — imitate it, never fight it.

- Task 1: the anti-corruption service layer — the typed port interface under
  src/services/<page>/port.ts matching the OpenAPI contract at
  contracts/<page>.openapi.yaml (domain names only), a mock adapter under
  src/services/<page>/mock.ts returning contract-shaped fixture data, and the
  registry wiring. No page code yet.
- Task 2: the page component(s) under src/app/<page>/ using ONLY the
  destination design-system components and the port — forms, validation with
  VERBATIM messages, navigation, and explicit state for anything the legacy
  app carried in the session or hidden fields.
- Task 3: component tests under tests/<page>.page.test.tsx in the house test
  style — spec'd fields render, spec'd validations fire with their exact
  messages, the port is called with contract-shaped payloads. Nothing else.
- Each task names the spec rules and scenarios it covers.
