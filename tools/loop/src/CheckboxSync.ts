/**
 * Deterministic, LLM-free synchronisation of Markdown task checkboxes from
 * plan-completion state. The loop never lets the model edit specs; this module
 * is the only writer, and it only ever flips `- [ ]` to `- [x]` (monotonic) so a
 * partial or failed run can never clobber a box a human already checked.
 */

const checkboxPattern = /^(\s*[-*] )\[[ xX]\]( .*)?$/

export interface CheckboxSyncResult {
  /** The updated Markdown (identical to the input when nothing changed). */
  readonly markdown: string
  /** How many boxes this call flipped from unchecked to checked. */
  readonly flipped: number
  /** Total number of checkbox lines found in the document. */
  readonly total: number
}

/**
 * Check the first `min(completed, total)` checkboxes — or every checkbox when
 * `allComplete` is set. Already-checked boxes are left untouched.
 *
 * Positional mapping is only trustworthy when the plan was derived 1:1 from
 * the spec's checklist. When the plan has a different number of tasks than
 * the spec has checkboxes, a partial sync would tick boxes describing work
 * that never happened (observed in dogfood run 2), so partial progress is NOT
 * written unless `planTasks` matches `total`. A fully completed plan still
 * checks every box: the spec's work is done regardless of how the plan
 * sliced it.
 */
export const syncCheckboxes = (
  markdown: string,
  completed: number,
  allComplete: boolean,
  planTasks: number
): CheckboxSyncResult => {
  const lines = markdown.split("\n")
  const total = lines.filter((line) => checkboxPattern.test(line)).length
  if (!allComplete && planTasks !== total) {
    return { markdown, flipped: 0, total }
  }
  const target = allComplete ? total : Math.min(Math.max(completed, 0), total)

  let seen = 0
  let flipped = 0
  const updated = lines.map((line) => {
    const match = checkboxPattern.exec(line)
    if (match === null) {
      return line
    }
    const index = seen
    seen += 1
    if (index >= target || line.includes("[x]") || line.includes("[X]")) {
      return line
    }
    flipped += 1
    return `${match[1]}[x]${match[2] ?? ""}`
  })

  return { markdown: updated.join("\n"), flipped, total }
}
