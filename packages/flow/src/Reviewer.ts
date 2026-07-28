import * as Schema from "effect/Schema"

export class Reviewer extends Schema.Class<Reviewer>("Reviewer")({
  name: Schema.String,
  systemPrompt: Schema.String,
  files: Schema.optionalKey(Schema.String)
}) {
  matches(changedFiles: ReadonlyArray<string>): boolean {
    if (this.files === undefined || changedFiles.length === 0) {
      return true
    }
    const pattern = new RegExp(this.files)
    return changedFiles.some((path) => pattern.test(path))
  }
}

export const parseReviewer = (name: string, text: string): Reviewer => {
  const parts = text.split("---\n", 3)
  const frontmatter = parts.length === 3 ? (parts[1] ?? "") : ""
  const body = parts.length === 3 ? (parts[2] ?? "").trim() : text.trim()
  const files = frontmatter
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("files:"))
    ?.split("files:", 2)[1]
    ?.trim()
  return Reviewer.make({
    name,
    systemPrompt: body,
    ...(files === undefined || files.length === 0 ? {} : { files })
  })
}
