import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import { SoapTransport, makeNodeSoapTransport } from "@llm4ts/flow/endpoint/Transport"
import { ToolContext, ToolReport, ToolSpec, specOf, type ToolShape } from "@llm4ts/flow/tools/Tool"
import { NodePlainFileStoreLive } from "./NodePlainFileStore.ts"

/**
 * The main of a kit tool file (`kits/<kit>/tools/<name>.ts`, ADR 0048):
 * `llm4ts tool` runs the file as a Node child and speaks this protocol —
 * `--describe` prints the `ToolSpec`; otherwise the parsed arguments arrive
 * as one JSON object on stdin and the `ToolReport` goes out on stdout. Exit
 * 0 when the report is ok, 1 when it carries issues, 2 when the tool could
 * not run (the error is JSON on stdout too, `{"error": …}`). `--project
 * <root>` names the project the tool runs for (default: the current
 * directory); secrets resolve from this process's environment.
 */
export const runToolMain = (tool: ToolShape): void => {
  if (process.argv.includes("--describe")) {
    process.stdout.write(`${JSON.stringify(Schema.encodeSync(ToolSpec)(specOf(tool)))}\n`)
    return
  }
  void readStdin().then((text) => {
    let values: Record<string, unknown>
    try {
      const parsed: unknown = text.trim().length === 0 ? {} : JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("stdin must hold one JSON object of arguments")
      }
      values = Object.fromEntries(Object.entries(parsed))
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`
      )
      process.exitCode = 2
      return
    }
    const projectFlag = process.argv.indexOf("--project")
    const projectRoot =
      projectFlag >= 0 && process.argv[projectFlag + 1] !== undefined
        ? process.argv[projectFlag + 1]
        : process.cwd()
    return Effect.runPromise(
      tool.execute(values).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodePlainFileStoreLive,
            Layer.succeed(ToolContext)({ projectRoot, environment: process.env }),
            Layer.succeed(SoapTransport)(makeNodeSoapTransport())
          )
        ),
        Effect.match({
          onFailure: (error) => {
            process.stdout.write(`${JSON.stringify({ error: error.message })}\n`)
            process.exitCode = 2
          },
          onSuccess: (report) => {
            process.stdout.write(`${JSON.stringify(Schema.encodeSync(ToolReport)(report))}\n`)
            process.exitCode = report.ok ? 0 : 1
          }
        })
      )
    )
  })
}

const readStdin = (): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks: Array<Buffer> = []
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")))
    process.stdin.on("error", rejectPromise)
  })

/** The child's stdout as the parent reads it: a report, or the error it printed. */
export const ChildToolOutput = Schema.Union([Schema.Struct({ error: Schema.String }), ToolReport])
