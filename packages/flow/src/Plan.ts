import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError } from "./FlowError.ts"

export class Task extends Schema.Class<Task>("Task")({
  title: Schema.String,
  description: Schema.String,
  completed: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  )
}) {}

export class Plan extends Schema.Class<Plan>("Plan")({
  epicId: Schema.String,
  tasks: Schema.Array(Task),
  brief: Schema.optionalKey(Schema.String)
}) {
  get nextIncomplete(): Task | undefined {
    return this.tasks.find((task) => !task.completed)
  }

  complete(title: string): Plan {
    return new Plan({
      ...this,
      tasks: this.tasks.map((task) =>
        task.title === title ? new Task({ ...task, completed: true }) : task
      )
    })
  }

  taskPrompt(task: Task): string {
    const brief = this.brief?.trim()
    return brief === undefined || brief.length === 0
      ? task.description
      : `${brief}\n\n---\n\n${task.description}`
  }

  get render(): string {
    const blocks = this.tasks.map((task) => {
      const box = task.completed ? "[x]" : "[ ]"
      return `## ${box} ${task.title}\n${task.description}`.trimEnd()
    })
    const core = [`# Plan: ${this.epicId}`, ...blocks].join("\n\n")
    const brief = this.brief?.trim()
    return brief === undefined || brief.length === 0 ? core : `${core}\n\n# Brief\n\n${brief}`
  }
}

export const stableHash = (input: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export const defaultPlanPath = (prompt: string, directory = ".llm4ts"): string =>
  `${directory}/plan-${stableHash(prompt)}.md`

const parseTask = (chunk: string): Effect.Effect<Task, PlanParseError> => {
  const lines = chunk.split("\n")
  const head = lines[0] ?? ""
  const match = /^## \[([ xX])\] (.+)$/.exec(head)
  const marker = match?.[1]
  const title = match?.[2]?.trim()
  return marker === undefined || title === undefined
    ? Effect.fail(
        PlanParseError.make({
          message: head.length === 0 ? "empty task chunk" : `malformed task header: ${head}`
        })
      )
    : Effect.succeed(
        Task.make({
          title,
          description: lines.slice(1).join("\n").trim(),
          completed: marker.toLowerCase() === "x"
        })
      )
}

const splitBrief = (body: string): readonly [tasks: string, brief: string | undefined] => {
  const lines = body.split("\n")
  const index = lines.findIndex((line) => line.trim() === "# Brief")
  if (index < 0) {
    return [body.trim(), undefined]
  }
  const brief = lines
    .slice(index + 1)
    .join("\n")
    .trim()
  return [lines.slice(0, index).join("\n").trim(), brief.length === 0 ? undefined : brief]
}

export const parsePlan = Effect.fn("@llm4ts/flow/Plan.parse")(function* (
  markdown: string
): Effect.fn.Return<Plan, PlanParseError> {
  const stripped = markdown.trim()
  const lines = stripped.split("\n")
  const header = lines[0] ?? ""
  const prefix = "# Plan: "
  if (!header.startsWith(prefix)) {
    return yield* PlanParseError.make({
      message: `expected a '${prefix}<epicId>' header`
    })
  }
  const [taskBody, brief] = splitBrief(lines.slice(1).join("\n").trim())
  const chunks =
    taskBody.length === 0
      ? []
      : taskBody
          .split(/^(?=## )/m)
          .map((chunk) => chunk.trim())
          .filter((chunk) => chunk.length > 0)
  const tasks = yield* Effect.forEach(chunks, parseTask)
  return Plan.make({
    epicId: header.slice(prefix.length).trim(),
    tasks,
    ...(brief === undefined ? {} : { brief })
  })
})

// ---- The task graph (ADR 0034) ------------------------------------------------

/**
 * The tasks a task waits for, from its description's `Depends on:` line
 * (`1, 3`, or `none`). Without the line it waits for the previous task, so
 * a plan written before ADR 0034 runs in order. Only earlier tasks count: a
 * forward or self reference is dropped, so the graph never has a cycle.
 */
export const dependsOnOf = (description: string, index: number): ReadonlyArray<number> => {
  const match = /\bDepends on:\s*([^\n.]*)/iu.exec(description)
  if (match === null) {
    return index > 1 ? [index - 1] : []
  }
  return [
    ...new Set(
      (match[1] ?? "")
        .split(/[^\d]+/u)
        .filter((part) => part.length > 0)
        .map((part) => Number.parseInt(part, 10))
        .filter((number) => Number.isInteger(number) && number >= 1 && number < index)
    )
  ]
}

/** The paths a task says it changes, from its `Owns:` line; empty when it says none. */
export const ownsOf = (description: string): ReadonlyArray<string> => {
  const match = /\bOwns:\s*([^\n]*)/iu.exec(description)
  return match === null
    ? []
    : (match[1] ?? "")
        .split(/[,\s]+/u)
        .map((path) => path.trim().replace(/^`|`$/gu, ""))
        .filter((path) => path.length > 0 && path.toLowerCase() !== "none")
}

/** One task of a plan as the scheduler sees it: its 1-based index and what it waits for. */
export interface TaskNode {
  readonly index: number
  readonly task: Task
  readonly dependsOn: ReadonlyArray<number>
  readonly owns: ReadonlyArray<string>
}

export const taskGraph = (plan: Plan): ReadonlyArray<TaskNode> =>
  plan.tasks.map((task, position) => ({
    index: position + 1,
    task,
    dependsOn: dependsOnOf(task.description, position + 1),
    owns: ownsOf(task.description)
  }))

/** Whether some task of the plan waits for anything but its predecessor alone. */
export const hasParallelTasks = (plan: Plan): boolean =>
  taskGraph(plan).some(
    (node) =>
      node.index > 1 && !(node.dependsOn.length === 1 && node.dependsOn[0] === node.index - 1)
  )
