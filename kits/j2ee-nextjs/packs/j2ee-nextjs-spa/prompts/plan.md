Derive the conversion task list for ONE domain feature from the Page Specs of
its programs. The destination is an existing Next.js SPA with a design system,
an AuthProvider, and a port/adapter service convention — imitate it, never
fight it. The feature's included fragments (header, nav, footer) are context:
use their specs for layout and navigation, do not re-implement them here
unless this feature IS the shell.

- Task 1: the feature's anti-corruption service layer — the typed port
  interface under src/services/<feature>/port.ts matching the OpenAPI contract
  at contracts/<feature>.openapi.yaml (domain names only, one operation per
  API call across all the feature's pages), a mock adapter under
  src/services/<feature>/mock.ts returning contract-shaped fixture data, and
  the registry wiring. No page code yet.
- Then ONE task per page of the feature, in navigation order (the page with no
  inbound link inside the feature first; list before edit; step 1 before
  step 2 before confirm): the page component(s) under src/app/<page>/ using
  ONLY the destination design-system components and the feature port —
  forms, validation with VERBATIM messages, navigation, explicit state for
  anything the legacy carried in the session or hidden fields — together with
  its component tests under tests/<page>.page.test.tsx in the house test style:
  spec'd fields render, spec'd validations fire with their exact messages, the
  port is called with contract-shaped payloads. Nothing else.
- Each task names the programs, spec rules, and scenarios it covers. Scenarios
  the decisions overlay marks drop, provided, or defer are out of scope: do
  not plan them, and use the target capability a `provided` entry points at.
