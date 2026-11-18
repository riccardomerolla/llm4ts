// Answers the `chief` flow behind `llm4ts chat` ("implement …" starts implement, anything else is
// answered with the runs it was shown), and the implement runs it starts as stubs/implement.cjs does.
const implement = require("./implement.cjs")

module.exports = (prompt, tools) => {
  if (!prompt.includes("Chief of Staff answering one chat request")) return implement(prompt, tools)
  const request = /Request from [^\n]*:\n([^\n]*)/.exec(prompt)?.[1] ?? ""
  if (request.startsWith("implement ")) {
    return JSON.stringify({
      action: "start_run",
      flow: "implement",
      task: request.slice("implement ".length),
      reply: "Starting implement."
    })
  }
  const runs = /Runs \(stop_run[^\n]*\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "(none)"
  return JSON.stringify({ action: "answer", reply: `Runs I know of: ${runs.trim()}` })
}
