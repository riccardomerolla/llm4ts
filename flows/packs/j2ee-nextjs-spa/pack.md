# Pack: j2ee-nextjs-spa

source: jsp
scaffold: ../../fixtures/scaffolds/nextjs-spa
sources: .*\.(jsp|java|xml)
programs: .*\.jsp
specs-dir: docs/modernization/specs
features-dir: docs/modernization/features
programFiles: (?:src/app/<NAME>(?:/.*)?|src/services/<NAME>(?:/.*)?|contracts/<NAME>\.openapi\.yaml|tests/<NAME>\..*)

## Gates

- typecheck: pnpm typecheck
- lint: pnpm lint
- test: pnpm test
- build: pnpm build

## Judge

- completeness (0..2): Every screen, servlet mapping (web.xml url-pattern), form field, navigation path, validation rule (client AND server side), user-facing message, session attribute, and API/ESB call in the JSP/servlet source is captured in the spec and BDD scenarios. Score 2 only if nothing material is missing.
- faithfulness (0..2): Every statement is grounded in the source: validation thresholds, exact message texts, redirect targets, session behaviour, DTO field names, and which ESB service each endpoint wraps match the code, and nothing is invented. Score 2 only if fully source-grounded.
- testability (0..2): Scenarios are concrete user journeys — specific accounts, amounts, and the exact message or destination screen expected; no vague language ("shows an error", "handled gracefully"). Score 2 only if every scenario is directly encodable as a test.
- pagespec (0..2): The spec contains exactly one ```json pagespec fenced block; its forms, apiCalls (with esbService), dtos (legacy→domain rename table), navigation, and sessionState agree with the prose and with the source; domain names are business language, never legacy abbreviations. Score 2 only if the block is present, consistent, and complete.

## Coverage: servlet-url

files: .*web\.xml
unit: <url-pattern>([^<]+)</url-pattern>

## Coverage: jsp-form

files: .*\.jsp
unit: action="([^"]+)"

## Coverage: jsp-ajax

files: .*\.jsp
unit: url:\s*['"]([^'"]+)['"]

## Survey: jsp-include

files: .*\.jsp
unit: <jsp:include page="([^"]+)"

## Survey: servlet-class

files: .*web\.xml
unit: <servlet-class>[a-z.]*\.([A-Za-z0-9]+)</servlet-class>
