// Plan the IBM ACE 12 implementation of an approved REST design: seed the ACE repository with contracts, stubs, and house rules, and write the story plan epic-stories executes.
//
// Runs rooted at the repository where soap-discover/sample/design ran; the
// ACE repository is --target (a git repository, created beforehand):
//
//   llm4ts run soap-epic --repo . -- --target ~/work/demo-bank-ace plan
//   llm4ts run soap-epic --repo . doctor          # is ACE 12 usable on this machine?
//
// `plan` requires design/api-design.md approved with no check errors. It
// writes into the target: contracts/ (the design, OpenAPI 3.1 and the 3.0.3
// variant ACE imports, the 1:1 mapping, the WSDL and XSDs), test-data/ (the
// masked exchanges, the stubs' source), docs/ (analysis reports, ESQL
// pattern cards) — all regenerated each run — and, only when absent, the
// ace12-rest-api scaffold (README, CONTRIBUTING.md house rules, gate
// scripts). Then it derives the story plan (skeleton, policies, shared
// library, stubs, one story per resource, contract check) and saves it at
// <target>/.llm4ts/epics/<epic-id>/plan.md, where epic-stories reads it; an
// existing plan is kept (editing it is the re-plan). It prints the exact
// epic-stories command: gates via scripts/ace-gates.sh, no worktree setup,
// concurrency 2, branches only. LLM4TS_ACE_API names the API project
// (default from the service), LLM4TS_SOAP_SERVICE picks the service.
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { makeStoryPlanStore } from "@llm4ts/flow/StoryPlan"
import {
  FlowAborted,
  Info,
  makeNodeWorkspace,
  mock,
  nodePlainFileStore,
  nodeProcessExecutor,
  resolveFlowInput,
  runFlowMain,
  runNode,
  ScriptUsage
} from "@llm4ts/runner"
import { analysisPaths, writeAnalyses } from "./lib/soap/Analysis.ts"
import { blockingIssues, checkDesign, designPaths, parseDesignFile } from "./lib/soap/Design.ts"
import {
  loadCatalog,
  loadOperationsFile,
  readIfPresent,
  serviceDirectory
} from "./lib/soap/Discover.ts"
import {
  apiNameFor,
  epicSentence,
  planViolations,
  seedFiles,
  storyPlanFor,
  writeSeed
} from "./lib/soap/Epic.ts"
import { readExchanges } from "./lib/soap/Samples.ts"
import { decodeXml } from "./lib/soap/Xml.ts"

const usage = 'usage: soap-epic [--target <ace-repo>] "plan | doctor"'
const kitRoot = fileURLToPath(new URL("..", import.meta.url))

const filesUnder = (
  root: string
): Effect.Effect<ReadonlyArray<{ path: string; contents: string }>> =>
  Effect.promise(async () => {
    const found: Array<{ path: string; contents: string }> = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name)
        if (entry.isDirectory()) await walk(full)
        else found.push({ path: relative(root, full), contents: await readFile(full, "utf8") })
      }
    }
    if (existsSync(root)) await walk(root)
    return found
  })

const parseEpicFlags = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let target: string | undefined
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index] ?? ""
      if (argument === "--target" || argument.startsWith("--target=")) {
        target = argument.includes("=") ? argument.slice("--target=".length) : argv[++index]
        if (target === undefined || target === "")
          return yield* ScriptUsage.make({ message: `--target needs a path\n${usage}` })
      } else rest.push(argument)
    }
    return { target, rest }
  })

const program = Effect.gen(function* () {
  const flags = yield* parseEpicFlags(process.argv.slice(2))
  const input = yield* resolveFlowInput("plan", flags.rest)
  const [command = "plan"] = input.prompt.trim().split(/\s+/)
  const environment = process.env

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: mock,
      environment
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))

        if (command === "doctor") {
          const profile =
            environment.MQSI_PROFILE ??
            join(environment.ACE_HOME ?? "/opt/ibm/ace-12", "server", "bin", "mqsiprofile")
          yield* say(
            `mqsiprofile: ${existsSync(profile) ? "found" : "missing"} at ${profile} (MQSI_PROFILE or ACE_HOME)`
          )
          if (!existsSync(profile)) {
            return yield* FlowAborted.make({
              message:
                "ACE 12 is not installed here, or MQSI_PROFILE/ACE_HOME do not point at it; the container gate (scripts/ace-gates-container.sh with ACE_IMAGE) is the alternative"
            })
          }
          // Only presence and version: the gates themselves prove the rest.
          const checks: ReadonlyArray<readonly [string, string]> = [
            ["ACE version", "mqsiservice -v"],
            ["ibmint", "command -v ibmint"],
            ["IntegrationServer", "command -v IntegrationServer"],
            ["mqsicreateworkdir", "command -v mqsicreateworkdir"]
          ]
          for (const [label, check] of checks) {
            const result = yield* nodeProcessExecutor
              .run(
                ["bash", "-c", `set +u; . "${profile}" >/dev/null 2>&1; ${check}`],
                input.workDir,
                {}
              )
              .pipe(Effect.result)
            const line =
              result._tag === "Success" && result.success.exitCode === 0
                ? `ok (${result.success.stdout.find((entry) => entry.trim() !== "")?.trim() ?? ""})`
                : "not found"
            yield* say(`${label}: ${line}`)
          }
          return
        }
        if (command !== "plan")
          return yield* FlowAborted.make({ message: `unknown command ${command}\n${usage}` })
        if (flags.target === undefined)
          return yield* FlowAborted.make({ message: `plan needs --target <ace-repo>\n${usage}` })
        const targetRoot = resolve(input.workspace, flags.target)
        if (!existsSync(targetRoot))
          return yield* FlowAborted.make({
            message: `${targetRoot} does not exist; create the ACE repository (git init) first`
          })
        if (!existsSync(join(targetRoot, ".git")))
          yield* say(
            `⚠ ${targetRoot} is not a git repository; epic-stories needs one with at least one commit`
          )

        const workspace = yield* makeNodeWorkspace(input.workDir)
        const requested = environment.LLM4TS_SOAP_SERVICE?.trim()
        const services = (yield* workspace.discover(".llm4ts/soap/*/catalog.json")).map(
          (path) => path.split("/")[2] ?? ""
        )
        const service =
          requested !== undefined && requested !== ""
            ? requested
            : services.length === 1
              ? services[0]
              : undefined
        if (service === undefined) {
          return yield* FlowAborted.make({
            message:
              services.length === 0
                ? "no discovered service here; run soap-discover first"
                : `several services (${services.join(", ")}); set LLM4TS_SOAP_SERVICE`
          })
        }
        const catalog = yield* loadCatalog(workspace, service)
        const operations = yield* loadOperationsFile(workspace, service)
        const paths = designPaths(serviceDirectory(service))
        const text = yield* readIfPresent(workspace, paths.design)
        if (text === undefined)
          return yield* FlowAborted.make({ message: `no ${paths.design}; run soap-design first` })
        const file = yield* parseDesignFile(text)
        const analyses = yield* writeAnalyses(workspace, catalog, service)
        const errors = blockingIssues(checkDesign(file.design, { catalog, operations, analyses }))
        if (!file.approved || errors.length > 0) {
          return yield* FlowAborted.make({
            message: `${paths.design} must be approved with no check errors (${file.approved ? `${errors.length} errors` : "not approved"}); run soap-design "check"`
          })
        }

        const api = environment.LLM4TS_ACE_API?.trim() || apiNameFor(service)
        const soapRoot =
          catalog.documents[0] === undefined ? undefined : dirname(catalog.documents[0])
        // Schemas may be declared in ISO-8859-1: decode by their declaration and
        // re-emit as UTF-8 so the ACE toolkit and git see one encoding.
        const soapDocuments = yield* Effect.forEach(
          catalog.documents.filter((document) => !/^https?:/i.test(document)),
          (document) =>
            Effect.gen(function* () {
              const bytes = yield* Effect.promise(() => readFile(document))
              const text = yield* decodeXml(new Uint8Array(bytes), document)
              return {
                path: relative(soapRoot ?? dirname(document), document),
                contents: text.replace(
                  /^(<\?xml[^>]*?encoding\s*=\s*["'])[^"']+(["'])/,
                  "$1UTF-8$2"
                )
              }
            })
        )
        if (soapDocuments.length < catalog.documents.length) {
          yield* say(
            "⚠ the WSDL was read from a URL: download it and its schemas into contracts/soap/ of the ACE repository"
          )
        }
        const analysisMarkdown = yield* Effect.forEach(catalog.operations, (operation) =>
          Effect.map(
            workspace.read(analysisPaths(service, operation.name).markdown),
            (markdown) => ({ operation: operation.name, markdown })
          )
        )
        const files = seedFiles({
          design: file.design,
          catalog,
          service,
          api,
          scaffold: yield* filesUnder(join(kitRoot, "scaffolds", "ace12-rest-api")),
          patterns: yield* filesUnder(join(kitRoot, "patterns")),
          soapDocuments,
          analyses: analysisMarkdown,
          exchanges: yield* readExchanges(workspace, service)
        })
        const target = yield* makeNodeWorkspace(targetRoot)
        const seeded = yield* writeSeed(target, files)
        yield* say(
          `seeded ${targetRoot}: ${seeded.written} files written, ${seeded.kept} team-owned files kept`
        )

        const plan = storyPlanFor({ design: file.design, service, api, analyses })
        const violations = planViolations(plan)
        if (violations.length > 0)
          return yield* FlowAborted.make({
            message: `derived story plan is invalid:\n${violations.join("\n")}`
          })
        const planPath = join(targetRoot, ".llm4ts", "epics", plan.epicId, "plan.md")
        const store = makeStoryPlanStore(nodePlainFileStore)
        const existing = yield* store.load(planPath)
        if (existing === undefined) {
          yield* store.save(planPath, plan)
          yield* say(`story plan: ${plan.stories.length} stories at ${planPath}`)
        } else {
          yield* say(
            `kept the existing story plan at ${planPath} (${existing.stories.length} stories); delete it to re-derive`
          )
        }
        for (const story of plan.stories) {
          yield* say(
            `  ${story.id}${story.dependsOn.length === 0 ? "" : ` (after ${story.dependsOn.join(", ")})`}: owns ${story.owned.join(", ")}`
          )
        }
        yield* say(
          [
            "next: review the plan, commit the seed in the ACE repository, then run",
            `  LLM4TS_GATES="bash scripts/ace-gates.sh build;bash scripts/ace-gates.sh test" LLM4TS_WORKTREE_SETUP= \\`,
            `    llm4ts run epic-stories --repo ${targetRoot} -- --concurrency 2 ${JSON.stringify(epicSentence(file.design, api, service))}`
          ].join("\n")
        )
      })
  )
})

runFlowMain(program)
