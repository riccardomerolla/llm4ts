# ADR 0011: Azure DevOps Runs On The `az` CLI, Not The REST API

## Status

Accepted (2026-08-24). Supersedes the HTTP transport in
`@llm4ts/flow/AzureDevOpsTool`.

## Context

`AzureDevOpsTool` was the odd one out. Every other hosted-service tool in
the flow package speaks to a vendor CLI through `ProcessExecutor` — `gh`
for `GitHubTool`, `basecamp` for `BasecampTool` (ADR 0009) — while Azure
DevOps built REST requests by hand, signed them with a Basic header
derived from a `Redacted` PAT, and pushed them through `HttpClient`.

That divergence cost more than symmetry:

- **The library held a credential.** `AdoConfig.pat` meant every consumer
  had to source, carry, and redact a PAT, and llm4ts had to be trusted not
  to leak it. `az` already owns an auth store (`az devops login`, or
  `AZURE_DEVOPS_EXT_PAT` read from the process environment by the CLI
  itself), exactly as `gh` owns GitHub's.
- **Hand-rolled plumbing.** A base64 encoder, an `AdoRequest` envelope, an
  `api-version` query parameter on every URL, and a bespoke
  `application/json-patch+json` document for what the CLI expresses as
  `--fields name=value`.
- **Two test idioms.** Azure DevOps needed the recorded HTTP boundary
  while its siblings used the process fake, so a reader had to learn both
  to review one package.
- **ADR 0009 already assumed this.** It cites "`az` variants" as the CLI
  precedent alongside `gh` — the decision record described a tool the code
  had not become.

The pinned `llm4zio` v4.2.0 `AdoTool.scala` is an HTTP bridge, so this is
a deliberate divergence rather than a parity gap.

## Decision

Convert `@llm4ts/flow/AzureDevOpsTool` to drive the `az` CLI
(`az boards`, `az repos`, and `az devops invoke`) through
`ProcessExecutorShape`, in the shape `GitHubTool` established: exported
pure args builders, exported pure parsers over `--output json`, and
`AdoRead` / `AdoWrite` capability guards around every call.

Specifics, and why:

- **No credential in the library.** `AdoConfig` loses `pat` entirely. The
  tool forwards an empty environment to the executor, so a PAT cannot
  reach argv, a log line, a trace, or a persisted plan even by accident.
  `apiVersion` survives for the one call with no first-class verb: reading
  work-item comments through `az devops invoke`.
- **`--detect false` on every invocation.** The CLI otherwise infers the
  organization from the working directory's git remote; a library that
  silently retargets another organization is a security surface, not a
  convenience.
- **WIQL values are escaped, not interpolated.** `quoteWiql` doubles
  embedded single quotes so a tag like `won't fix` — or a hostile one —
  cannot terminate a literal and rewrite the query.
- **Queue reads are one call.** `az boards query` flattens a WIQL result
  into full work items, so `listWorkItems` polls a queue without a
  fan-out over ids.
- **Tags are read-merge-write.** Azure DevOps stores tags as one
  semicolon-joined `System.Tags` string, so `editTags` reads the item,
  merges case-insensitively (the service treats tags that way), and
  writes the field back. It is not a label API and is not pretended to be.
- **Branch policies stand in for checks.** `prPolicies` maps policy
  evaluation statuses onto `Success` / `Failure` / `Pending`. There is no
  `TimedOut` status in Azure DevOps, so the outcome set is GitHub's minus
  that member rather than a forced match.
- **Still a standalone sibling.** No shared `WorkQueue` interface is
  extracted here, for the reason ADR 0009 gave: the abstraction should
  follow a flow that genuinely needs backend-agnostic queueing, with its
  own ADR.

The surface also grows the operations a control plane needs and the CLI
makes cheap — `listWorkItems`, `readComments`, `writeComment`,
`createWorkItem`, `editTags`, `openPrForBranch`, `updatePr`,
`writePrComment`, `prPolicies`, `completePr` — so that an Azure DevOps
consumer is not forced back into a parallel client for half its work.

## Amendment (2026-08-25): Development links

Consumers that run a work queue on Azure DevOps hit a structural gap the
original conversion did not cover. A GitHub issue belongs to a repository,
so "which repository is this work in?" is free. An Azure DevOps work item
belongs to a **project**, and a project holds many repositories — the
answer lives in the work item's **Development** section, as `ArtifactLink`
relations to a branch, a pull request, or a commit.

Reading and writing those links is Azure DevOps protocol, not consumer
policy, so it belongs here rather than in each consumer: `developmentLinks`,
`linkArtifact`, `repository`, and the pure `artifactUri` /
`parseArtifactUri` pair. Which repository a given work item should be
worked in, and when to link a branch or a pull request back, stay the
consumer's decisions.

Two details forced by the platform rather than chosen:

- **Artifact URIs address GUIDs, not names.** `vstfs:///Git/Ref/{projectId}
%2F{repositoryId}%2FGB{branch}` cannot be built from a repository name,
  which is why `repository(name)` exists at all. It is deliberately not
  cached inside the tool: the call is one `az repos show`, and hidden
  per-instance state would make `makeAzureDevOpsTool` Effect-returning for
  no real gain. Consumers that poll in a loop can cache it themselves.
- **The triple is one encoded segment.** Encoding it as three segments
  would corrupt every branch name containing a slash — which is most of
  them under any `feature/` or `factory/` convention.

## Consequences

- **Breaking for existing consumers.** `makeAzureDevOpsTool` now takes a
  process executor and a working directory where it took an HTTP client.
  `AdoRequest`, `authorizationHeader`, `readWorkItemRequest`,
  `wiqlRequest`, `setFieldsRequest`, `createPullRequestRequest`, and
  `parseWiqlIds` are gone, replaced by args builders and
  `parseWorkItemIds`. `AdoConfig.pat` is removed: callers move the PAT
  into `az devops login` or `AZURE_DEVOPS_EXT_PAT`. `WorkItem` gains
  `createdBy` and `changedDate`. Recorded in `docs/parity.md`.
- **Azure DevOps access needs the CLI installed and authenticated** —
  `az` plus the `azure-devops` extension — the same operational bargain
  `gh` already imposes. Default CI is unaffected: tests use the process
  fake and checked-in `--output json` fixtures, never the real CLI.
- The capability system governs Azure DevOps exactly as before; only the
  transport under the guard changed.
