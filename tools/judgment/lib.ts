import { execFileSync } from "node:child_process"
import {
  correctnessReviewer,
  readabilityReviewer,
  testReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
} from "@llm4ts/flow/Review"
import type { Reviewer } from "@llm4ts/flow/Reviewer"

export const lenses: ReadonlyArray<Reviewer> = [
  correctnessReviewer,
  readabilityReviewer,
  testReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
]

export const argValue = (
  name: string,
  fallback: string,
  args: ReadonlyArray<string> = process.argv
): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

export interface Commit {
  readonly sha: string
  readonly title: string
  readonly diff: string
}

export const commits = (
  repo: string,
  commitCount: number,
  diffCap = 60000
): ReadonlyArray<Commit> => {
  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return git("log", "--no-merges", `-${commitCount}`, "--format=%H%x1f%s")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", title = ""] = line.split("\x1f")
      const diff = git("show", "--format=", "--no-color", sha)
      return { sha, title, diff: diff.length > diffCap ? `${diff.slice(0, diffCap)}\n…` : diff }
    })
    .filter((commit) => commit.diff.trim().length > 0)
}
