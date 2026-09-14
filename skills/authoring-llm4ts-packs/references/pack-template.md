# Minimal pack template

Save as `packs/<name>/pack.md`. This exact text loads; it is the manifest
chapter 5 of the getting started guide checks against the estate.

```md
# Pack: my-pack

source: jsp
sources: ._\.(jsp|java|xml)
programs: ._\.jsp
specs-dir: docs/modernization/specs
features-dir: docs/modernization/features

## Gates

- test: pnpm test

## Judge

- completeness (0..2): Every screen, form field, and validation rule in the source is captured.
- faithfulness (0..2): Every statement is grounded in the source; nothing is invented.

## Coverage: jsp-form

files: .\*\.jsp
unit: action="([^"]+)"

## Survey: jsp-include

files: .\*\.jsp
unit: <jsp:include page="([^"]+)"
```

A reviewer lens, `packs/<name>/reviewers/house-style.md`:

```md
---
files: .*\.(ts|tsx)
---

Review the change for the target's house style: domain names in business
language, no legacy abbreviations, every user-facing message copied from
the spec verbatim.
```

A phase prompt, `packs/<name>/prompts/spec.md`, is plain Markdown prose the
extract phase appends to its spec-writing prompt.
