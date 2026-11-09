// Answers the `implement` flow: a two-task plan, clean reviews, and one edit per coding turn.
module.exports = (prompt, { fs }) => {
  if (prompt.includes("planning assistant")) {
    return JSON.stringify({
      epicId: "calculator",
      tasks: [
        { title: "Add multiply", description: "Add a multiply function", completed: false },
        { title: "Test multiply", description: "Cover multiply with a test", completed: false }
      ]
    })
  }
  if (prompt.includes("Report problems as JSON")) {
    return JSON.stringify({ issues: [], summary: "clean" })
  }
  fs.appendFileSync("calculator.txt", "step\n")
  return "Implemented the task."
}
