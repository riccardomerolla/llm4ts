import { diff } from "./Diff.ts"
import { jsonValidate } from "./JsonValidate.ts"
import type { ToolShape } from "./Tool.ts"

/** The tools every install has, before any kit or pack adds its own. */
export const builtinTools: ReadonlyArray<ToolShape> = [jsonValidate, diff]

export const builtinTool = (name: string): ToolShape | undefined =>
  builtinTools.find((tool) => tool.name === name)
