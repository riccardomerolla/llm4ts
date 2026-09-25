# Runbook: from a WSDL to ACE 12 branches

A developer laptop with Node 22+, llm4ts, a Claude (or other) CLI for the
reasoning seat, and IBM ACE 12 installed. Rehearse it first on the
synthetic fixture (every command below works against it with the stub), then
on a real service in dev, test, or uat, never production.

## 0. Two repositories

```bash
mkdir -p ~/work/conti-analysis ~/work/conti-ace
git -C ~/work/conti-analysis init && git -C ~/work/conti-ace init
cd ~/work/conti-analysis
```

The analysis repository holds `.llm4ts/soap/<service>/`: catalog, samples,
analysis, design. The ACE repository receives the contracts and the code.

## 1. Discover

```bash
llm4ts run soap-discover --repo . ./wsdl/ContiService.wsdl        # or an https URL
```

Read `catalog.md`, especially the open questions. Review
`operations.md`: every `class:` is `read` or `mutating`; set
`Status: confirmed`. For a URL behind auth, write `auth.json` first (below)
and set `LLM4TS_SOAP_SERVICE`.

## 2. Credentials and environment

`.llm4ts/soap/<service>/auth.json` (gitignored), references only:

```json
{
  "environment": "test",
  "endpoint": "https://esb-test.bank.internal/soap/Conti",
  "call": {
    "auth": { "scheme": "basic", "user": "svc-conti", "password": "env:CONTI_PASSWORD" },
    "tls": { "pfx": "file:/secure/client.p12", "passphrase": "env:P12_PASS" }
  },
  "wsSecurity": { "user": "env:WS_USER", "password": "env:WS_PASSWORD", "passwordType": "digest" }
}
```

## 3. Samples

```bash
llm4ts run soap-sample --repo . "import ./ContiService-soapui-project.xml"   # if the team has one
llm4ts run soap-sample --repo . "propose cercaMovimenti"                      # scenario drafts
llm4ts run soap-sample --repo . "init dettaglioConto"                        # or write one by hand
llm4ts run soap-sample --repo . "call all"
llm4ts run soap-sample --repo . -- --allow-mutating revocaBonifico "call revocaBonifico/gia-eseguito"
llm4ts run soap-sample --repo . list
```

Replace seeded identifiers with ones the test environment knows before
calling. Rehearsal without a backend: `LLM4TS_SOAP_STUB=<dir of <operation>.xml>`.

## 4. Analyse and design

```bash
llm4ts run soap-design --repo . analyse      # read analysis/*.md: this is the evidence
llm4ts run soap-design --repo . design       # draft design/api-design.md
llm4ts run soap-design --repo . check        # edit the JSON block, re-check, repeat
llm4ts run soap-design --repo . revise       # optional: let the seat fix what check found
```

Set `Status: approved` when the check reports no errors and the warnings are
understood; then `llm4ts run soap-design --repo . openapi`.

## 5. Plan the ACE build

```bash
llm4ts run soap-epic --repo . doctor
llm4ts run soap-epic --repo . -- --target ~/work/conti-ace plan
git -C ~/work/conti-ace add -A && git -C ~/work/conti-ace commit -m "Seed from soap-ace"
```

Review `.llm4ts/epics/<epic-id>/plan.md` in the ACE repository (edit it to
re-plan), then run the command `plan` printed:

```bash
LLM4TS_GATES="bash scripts/ace-gates.sh build;bash scripts/ace-gates.sh test" LLM4TS_WORKTREE_SETUP= \
  llm4ts run epic-stories --repo ~/work/conti-ace -- --concurrency 2 "<the epic sentence>"
```

Each story lands on its own branch and merges into `epic/<epic-id>` after its
gates and judge pass; nothing reaches `main` without a human. The board and
report live under `.llm4ts/epics/<epic-id>/`. Azure DevOps mirroring is the
optional board of ADR 0011.

## When something is off

- `ace-gates.sh` cannot find `mqsiprofile`: set `MQSI_PROFILE` or `ACE_HOME`;
  on a machine without ACE use `scripts/ace-gates-container.sh` with
  `ACE_IMAGE`.
- Your ACE fix pack spells a command differently: override the whole gate
  with `LLM4TS_GATES`.
- The service changed: rerun discover, sample, analyse, and `check`; the
  design check points at every citation that broke. `soap-epic plan`
  regenerates contracts and keeps the team's files.
