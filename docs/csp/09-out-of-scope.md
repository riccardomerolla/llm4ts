# Out Of Scope

## Do Not Recreate Source Internals

The Rust build team must not recreate or preserve:

- source repository directory structure;
- source file paths;
- source-language syntax, keywords, type declarations, or helper functions;
- internal helper names, private module names, private parsers, private regex names, or private prompt constants;
- exact implementation algorithms where only outcomes are contractual;
- exact source documentation prose, comments, log strings, test names, assertion messages, or error-message wording;
- generated build artifacts or local cache metadata;
- exact plan-file heading strings or hash algorithm unless a product owner separately requires file-format compatibility.

## Do Not Preserve Source Branding By Default

The CSP uses neutral names. The Rust product may choose its own target branding, but the source project's branded names and source-specific environment prefix are not required by the clean specification.

## Do Not Recreate Prompt Text

The source contains reviewer prompts, planning prompts, and fixer prompts. Those exact prompts are not part of this clean-room contract. Required behavior is:

- planners return the specified structured shapes;
- reviewers return structured review results;
- fix loops ask the coder to address findings;
- interactive planning may ask user questions before proposing;
- PR summarization returns title and body.

The Rust build team should write new prompts from the behavior in this CSP.

## Do Not Treat Examples As Source Scripts

Example workflows are behavioral guidance, not a requirement to reproduce exact script files or wording. The Rust implementation should provide equivalent workflow capabilities:

- autonomous implementation;
- interactive planning;
- enhanced plan review and brief;
- live interactive coder session;
- issue-to-PR;
- bugfix with failing-test gate;
- spec-driven implementation;
- local-only provider setup;
- Azure DevOps board-driven flow.

## Do Not Include Secrets Or Fixture Data

Do not copy any credentials, local paths, customer data, account ids, internal URLs, or private fixture data. The deterministic mock connector may return simple canned data for tests, but it should not reproduce source demo issue text or example fixture wording.

## Not A Build Plan

This CSP does not implement the Rust port, choose exact crate names, choose exact dependencies, or prescribe internal architecture beyond behaviorally meaningful boundaries. The build team may choose any Rust crates and runtime approach that satisfy the public contracts.

## Not A License Or Security Audit

This extract is not legal advice, a license audit, or a vulnerability assessment. A formal clean-room program needs independent process controls, team isolation, audit logs, and qualified legal review.
