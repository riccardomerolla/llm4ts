# `llm4ts doctor` as a typed report

Turn the doctor printout into a typed report: a `DoctorCheck` per line with
a classification and a remediation, `--json`, `--flow <name>` to scope the
checks to what that flow needs, and exit 1 when a required check fails.
Item 4 of `docs/research/rea-gap-analysis.md` section 6; no ADR.

Driver: the first red story in a customer run is often a doctor finding
nobody asserted on; `Doctor.ts` builds lines, not records, so neither a
script nor a flow can read it.

## Decisions

| Decision       | Choice                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record         | `DoctorCheck { name, group: connectors \| credentials \| gates \| prerequisites \| otel \| roster, ok, required, classification, summary, remediation?, detail? }`.                                               |
| Classification | `healthy \| missing_credential \| missing_cli \| cli_too_old \| node_mismatch \| otlp_unreachable \| roster_invalid \| policy_conflict \| unknown`; one per check; `unknown` only for a probe that could not run. |
| Required       | A check is required when the scoped flow needs it: a connector the roster names, the Node preflight, the gates the flow runs; everything else is advisory and never fails the exit.                               |
| Scope          | `--flow <name>` reads the flow's roster and gate needs through the catalog (`FlowCatalog.ts`) and `nodePreflightReport`; without it every check is advisory, as today.                                            |
| Output         | Text unchanged in shape (the marks and hints stay); `--json` prints `{ version, checks }`; exit 1 when any required check is not ok, 0 otherwise.                                                                 |
| Seam           | `makeDoctorProgram` keeps its signature and returns the report; rendering is a pure function over the checks; no second doctor.                                                                                   |

## Modules

- `packages/runner/src/Doctor.ts`: `DoctorCheck`, `DoctorReport` schemas;
  each existing probe (`geminiPrerequisites`, `geminiBridgePrerequisites`,
  `geminiModelModePrerequisites`, OTLP probe, Node preflight, connectors,
  credentials) returns a `DoctorCheck`; `renderDoctor(report)`.
- `packages/shell/src/Cli.ts`: `--json`, `--flow`, exit code on
  `doctorCommand`.
- `packages/runner/src/ExecutorRoster.ts`: a `roster_invalid` check when a
  roster file is configured.

## Tasks

- [ ] Schemas and the probe conversions; the text output is byte-identical
      for the existing doctor test fixtures.
- [ ] `--json` and a decode test on the printed document.
- [ ] `--flow` scoping through the catalog; required set per flow.
- [ ] Exit code; a test with a fake registry where a required connector is
      down.
- [ ] Roster check.
- [ ] `docs/configuration.md` doctor section, CHANGELOG.

## Tests

Fake registry, fake environment and fake process executor: a missing
`GEMINI_API_KEY` with a Gemini seat in the roster is `missing_credential`,
required under `--flow epic-stories`, advisory without; an OTLP endpoint
that refuses is `otlp_unreachable` and never required; `--json` decodes to
the schema.

## Non-goals

Auto-fixing anything (ADR 0016 keeps the bridge detect-and-report);
writing harness configuration; network probes beyond the ones doctor
already makes.
