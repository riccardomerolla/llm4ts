import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { stableHash } from "@llm4ts/flow/Plan"
import { Story, StoryPlan, storyPlanViolations } from "@llm4ts/flow/StoryPlan"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import type { OperationAnalysis } from "./Analysis.ts"
import type { WsdlCatalog } from "./Catalog.ts"
import { ApiDesign, type Endpoint } from "./Design.ts"
import { encodeMapping, mapService } from "./Mapping.ts"
import { projectOpenApi, renderTypedYaml } from "./OpenApi.ts"
import type { Exchange } from "./Samples.ts"

// From an approved design to an ACE 12 implementation plan. The story split
// is derived, not generated: a skeleton story owns the REST API project's
// descriptors and main flow, three foundation stories own the policy
// project, the shared library, and the test stubs, one story per resource
// owns that resource's broker schema folder and tests, and a contract-check
// story closes the epic. The plan is written where the engine's
// `epic-stories` flow looks for it, so that flow executes it unchanged
// (worktrees, gates, judge, board — ADR 0013); an existing plan wins.

/** `DemoBankService` → `DemoBankApi`; `LLM4TS_ACE_API` overrides. */
export const apiNameFor = (service: string): string => {
  const base = service.replace(/[^A-Za-z0-9]/g, "").replace(/(Service|Ws|WS|Soap)$/, "")
  const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}Api`
  return /^[A-Za-z]/.test(name) ? name : `Api${name}`
}

/** `credit-transfers` → `creditTransfers`: a valid ESQL broker schema name. */
export const schemaFolder = (resource: string): string =>
  resource.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())

/** Endpoints grouped by their first path segment (the resource). */
export const resourcesOf = (
  design: ApiDesign
): ReadonlyArray<readonly [string, ReadonlyArray<Endpoint>]> => {
  const groups = new Map<string, Array<Endpoint>>()
  for (const endpoint of design.endpoints) {
    const resource = endpoint.path.split("/")[1] ?? "root"
    groups.set(resource, [...(groups.get(resource) ?? []), endpoint])
  }
  return [...groups]
}

/** The epic id `epic-stories` derives from the epic text: slug of four words plus a hash. */
export const epicIdFor = (epic: string): string => {
  const slug = epic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((part) => part.length > 0)
    .slice(0, 4)
    .join("-")
  return `${slug.length === 0 ? "epic" : slug}-${stableHash(epic).slice(0, 6)}`
}

export const epicSentence = (design: ApiDesign, api: string, service: string): string =>
  `Implement the ${api} REST API on IBM ACE 12: ${design.endpoints.length} endpoints of "${design.title}" over the ${service} SOAP service, from the approved contract in contracts/.`

const endpointLine = (endpoint: Endpoint): string =>
  `${endpoint.method} ${endpoint.path} (${endpoint.operationId}) from ${endpoint.sources.join(" + ")}${endpoint.errors.length === 0 ? "" : `; errors ${endpoint.errors.map((error) => `${error.status} ${error.code} ← ${error.from.join("/")}`).join(", ")}`}`

export const storyPlanFor = (options: {
  readonly design: ApiDesign
  readonly service: string
  readonly api: string
  readonly analyses: ReadonlyArray<OperationAnalysis>
}): StoryPlan => {
  const { design, api, service } = options
  const lib = `${api}Lib`
  const policies = `${api}Policies`
  const tests = `${api}_Test`
  const resources = resourcesOf(design)
  const contracts = ["contracts", "docs", "test-data", "CONTRIBUTING.md"]
  const foundation = ["api-skeleton", "policies", "shared-lib", "backend-stub"]

  const stories: Array<Story> = [
    Story.make({
      id: "api-skeleton",
      title: `${api} REST API project skeleton`,
      description: [
        `Create the ACE 12 REST API project ${api}/ from contracts/openapi-ace.yaml: .project, restapi.descriptor, application.descriptor, the imported OpenAPI document as ${api}/openapi.yaml, and the generated main flow under ${api}/gen/ routing each operation to its subflow.`,
        `Each operation's subflow is ${api}/<schema>/<operationId>.subflow in the resource's broker schema folder; create the routing only — the resource stories implement the subflows (create each as an empty pass-through the resource story will replace).`,
        "Operations and their subflows:",
        ...resources.flatMap(([resource, endpoints]) =>
          endpoints.map(
            (endpoint) =>
              `- ${schemaFolder(resource)}.${endpoint.operationId}: ${endpoint.method} ${design.basePath}${endpoint.path}`
          )
        )
      ].join("\n"),
      owned: [
        `${api}/.project`,
        `${api}/restapi.descriptor`,
        `${api}/application.descriptor`,
        `${api}/openapi.yaml`,
        `${api}/gen`
      ],
      sharedReadOnly: contracts,
      provides: resources.flatMap(([resource, endpoints]) =>
        endpoints.map(
          (endpoint) =>
            `${api}/${schemaFolder(resource)}/${endpoint.operationId}.subflow is routed from the main flow`
        )
      )
    }),
    Story.make({
      id: "policies",
      title: `${policies} policy project for dev, test, and uat`,
      description: [
        `Create the ACE policy project ${policies}/ holding, for each environment (dev, test, uat), the backend endpoint of the ${service} SOAP service, the TLS client identity and truststore references, and the WS-Security user token reference, as policies the SOAPRequest node reads.`,
        "No value is hard-coded outside the policies; credentials are references to the integration server's vault or keystore, never literals."
      ].join("\n"),
      owned: [policies],
      sharedReadOnly: contracts,
      provides: [
        `${policies}: one backend policy per environment, selected by the integration server's configuration`
      ]
    }),
    Story.make({
      id: "shared-lib",
      title: `${lib} shared library: WSDL, backend call, error mapping`,
      description: [
        `Create the shared library ${lib}/: import the WSDL and XSDs from contracts/soap/, a subflow that calls the backend through a SOAPRequest node configured from ${policies}, and the error subflow that turns an esito code or SOAP fault into the RFC 9457 problem the contract names (x-problem-codes), defaulting to 502 backend-error.`,
        "Follow docs/patterns/PAT-ACE-001 and PAT-ACE-002."
      ].join("\n"),
      owned: [lib],
      sharedReadOnly: contracts,
      provides: [`${lib}: CallBackend and MapError subflows; the imported WSDL`]
    }),
    Story.make({
      id: "backend-stub",
      title: `${tests} project and recorded backend stubs`,
      description: [
        `Create the ACE unit test project ${tests}/ (JUnit, ACE 12.0.7+ test framework) and turn every masked exchange in test-data/ into a stub the tests can play back in place of the SOAP backend, one per recorded response, named <operation>/<sample>.`,
        "Add the shared test support (loading a stub, asserting a JSON body against contracts/openapi-ace.yaml) under the support package."
      ].join("\n"),
      owned: [`${tests}/.project`, `${tests}/.classpath`, `${tests}/stubs`, `${tests}/src/support`],
      sharedReadOnly: contracts,
      provides: [
        `${tests}/stubs/<operation>/<sample>.xml and the support package for every resource's tests`
      ]
    })
  ]

  for (const [resource, endpoints] of resources) {
    const folder = schemaFolder(resource)
    const sources = [...new Set(endpoints.flatMap((endpoint) => endpoint.sources))]
    const findings = options.analyses
      .filter((analysis) => sources.includes(analysis.operation))
      .flatMap((analysis) =>
        analysis.observations.map((line) => `- ${analysis.operation}: ${line}`)
      )
    stories.push(
      Story.make({
        id: `resource-${resource}`,
        title: `${resource}: ${endpoints.map((endpoint) => endpoint.operationId).join(", ")}`,
        description: [
          `Implement the ${resource} resource in the broker schema folder ${api}/${folder}/: one subflow per operation (replacing the skeleton's pass-through) with its ESQL mapping modules, calling the backend through ${lib}, and its tests in ${tests}/src/${folder}/ against the recorded stubs.`,
          "Endpoints:",
          ...endpoints.map((endpoint) => `- ${endpointLine(endpoint)}`),
          ...(findings.length === 0
            ? []
            : ["What the samples showed (handle every case):", ...findings]),
          "Follow CONTRIBUTING.md and docs/patterns/."
        ].join("\n"),
        dependsOn: foundation,
        owned: [`${api}/${folder}`, `${tests}/src/${folder}`],
        sharedReadOnly: [
          ...contracts,
          `${api}/gen`,
          lib,
          policies,
          `${tests}/stubs`,
          `${tests}/src/support`
        ],
        provides: endpoints.map(
          (endpoint) => `${endpoint.method} ${design.basePath}${endpoint.path}`
        )
      })
    )
  }

  stories.push(
    Story.make({
      id: "contract-check",
      title: "Contract check across every operation",
      description: [
        `Add ${tests}/src/contract/: one test per operation of contracts/openapi-ace.yaml that calls it through the deployed flow with a recorded stub and validates status, headers, and body against the contract, plus one per mapped problem code.`,
        "A mismatch is a finding for the resource story that owns the operation, reported with BLOCKED_ON."
      ].join("\n"),
      dependsOn: resources.map(([resource]) => `resource-${resource}`),
      owned: [`${tests}/src/contract`],
      sharedReadOnly: [...contracts, api, lib, policies, `${tests}/stubs`, `${tests}/src/support`],
      provides: ["every operation of the contract exercised end to end"]
    })
  )

  const epic = epicSentence(design, api, service)
  return StoryPlan.make({ epicId: epicIdFor(epic), epic, stories })
}

export const planViolations = storyPlanViolations

// ---------------------------------------------------------------------------
// Seeding the ACE repository

export interface SeedFile {
  readonly path: string
  readonly contents: string
  /** Generated from upstream on every run, vs. created once and then owned by the team. */
  readonly regenerated: boolean
}

export const seedFiles = (options: {
  readonly design: ApiDesign
  readonly catalog: WsdlCatalog
  readonly service: string
  readonly api: string
  readonly scaffold: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly patterns: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly soapDocuments: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly analyses: ReadonlyArray<{ readonly operation: string; readonly markdown: string }>
  readonly exchanges: ReadonlyArray<Exchange>
}): ReadonlyArray<SeedFile> => {
  const substitute = (text: string) =>
    text.replace(/__API__/g, options.api).replace(/__SERVICE__/g, options.service)
  return [
    ...options.scaffold.map((file) => ({
      path: substitute(file.path),
      contents: substitute(file.contents),
      regenerated: false
    })),
    {
      path: "contracts/api-design.json",
      contents: `${JSON.stringify(Schema.encodeSync(ApiDesign)(options.design), null, 2)}\n`,
      regenerated: true
    },
    {
      path: "contracts/openapi.yaml",
      contents: renderTypedYaml(projectOpenApi(options.design)),
      regenerated: true
    },
    {
      path: "contracts/openapi-ace.yaml",
      contents: renderTypedYaml(projectOpenApi(options.design, { dialect: "3.0" })),
      regenerated: true
    },
    {
      path: "contracts/mapping.json",
      contents: encodeMapping(mapService(options.catalog)),
      regenerated: true
    },
    ...options.soapDocuments.map((file) => ({
      path: `contracts/soap/${file.path}`,
      contents: file.contents,
      regenerated: true
    })),
    ...options.analyses.map((analysis) => ({
      path: `docs/analysis/${analysis.operation}.md`,
      contents: analysis.markdown,
      regenerated: true
    })),
    ...options.patterns.map((file) => ({
      path: `docs/patterns/${file.path}`,
      contents: file.contents,
      regenerated: true
    })),
    ...options.exchanges.flatMap((exchange) =>
      exchange.response === undefined || exchange.response.envelope === ""
        ? []
        : [
            {
              path: `test-data/${exchange.operation}/${exchange.name}.response.xml`,
              contents: `<!-- masked ${exchange.provenance} sample: ${exchange.purpose.replace(/--/g, "- -")} -->\n${exchange.response.envelope}\n`,
              regenerated: true
            },
            ...(exchange.request === undefined
              ? []
              : [
                  {
                    path: `test-data/${exchange.operation}/${exchange.name}.request.xml`,
                    contents: `${exchange.request.envelope}\n`,
                    regenerated: true
                  }
                ])
          ]
    )
  ]
}

/** Write regenerated files always and team-owned scaffold files only when absent. */
export const writeSeed = (
  target: WorkspaceShape,
  files: ReadonlyArray<SeedFile>
): Effect.Effect<{ readonly written: number; readonly kept: number }, WorkspaceError> =>
  Effect.gen(function* () {
    let written = 0
    let kept = 0
    for (const file of files) {
      if (!file.regenerated) {
        const existing = yield* target.discover(file.path)
        if (existing.includes(file.path)) {
          kept++
          continue
        }
      }
      yield* target.write(file.path, file.contents)
      written++
    }
    return { written, kept }
  })
