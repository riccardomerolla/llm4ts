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
