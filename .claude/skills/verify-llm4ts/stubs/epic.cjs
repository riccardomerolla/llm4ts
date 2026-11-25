// Answers the `epic-stories` flow: three stories (`add`, `slow`, and `mul`, which depends on
// `add`), a one-task plan per story, clean reviews, a passing judge, and one file per story.
//
// The coding turn of `slow` sleeps for the seconds in `<sandbox>/epic/sleep` (none when the
// file is absent), so a run stays alive long enough to be steered. Coding turns are logged
// to `<sandbox>/epic/claude.log` with a START and a DONE line each; a turn that was killed
// has no DONE line.
module.exports = (prompt, { fs, path }) => {
  if (prompt.includes("Split the epic below into stories")) {
    const story = (id, dependsOn) => ({
      id,
      title: id,
      description: `Write ${id}.txt`,
      dependsOn,
      owned: [`${id}.txt`],
      sharedReadOnly: [],
      provides: [`${id}.txt`]
    })
    return JSON.stringify({
      epicId: "calc",
      epic: "Add a calculator",
      stories: [story("add", []), story("slow", []), story("mul", ["add"])]
    })
  }
  if (prompt.includes("planning the implementation of ONE story")) {
    const asked = /Use exactly this epicId: "([^"]+)"/.exec(prompt)
    return JSON.stringify({
      epicId: asked === null ? "story" : asked[1],
      tasks: [{ title: "Write the file", description: "Write the owned file", completed: false }]
    })
  }
  if (prompt.includes("Report problems as JSON")) {
    return JSON.stringify({ issues: [], summary: "clean" })
  }
  if (prompt.includes("You are an impartial evaluator")) {
    const scores = [...prompt.matchAll(/^- ([\w-]+) \(0\.\.(\d+)\)/gm)].map((match) => ({
      name: match[1],
      score: Number(match[2]),
      reasoning: "fine"
    }))
    return JSON.stringify({ scores })
  }

  // A coding turn: it runs in the story's worktree, whose directory is named after the story.
  const state = path.join(path.dirname(path.dirname(process.argv[1])), "epic")
  fs.mkdirSync(state, { recursive: true })
  const story = path.basename(process.cwd())
  const log = (word) =>
    fs.appendFileSync(
      path.join(state, "claude.log"),
      `${new Date().toISOString().slice(11, 23)} pid=${process.pid} code ${word} in ${story}\n`
    )
  log("START")
  fs.appendFileSync(`${story}.txt`, "step\n")
  let seconds = 0
  if (story === "slow") {
    try {
      seconds = Number(fs.readFileSync(path.join(state, "sleep"), "utf8").trim())
    } catch {
      seconds = 0
    }
  }
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
  log("DONE")
  return "Implemented the task."
}
