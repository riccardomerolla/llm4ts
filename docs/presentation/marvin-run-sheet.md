# Marvin — run sheet for "the run is the talk"

Ten minutes. One screen: `marvin-run.html`. The presenter does not click
during the run. This sheet lives on a phone or a second screen.

## Before the room fills

- Open `docs/presentation/marvin-run.html` in a Chromium browser, full
  screen, and share that window. Check the title renders in Geist (the fonts
  come from Google Fonts: with no network the page still works in the system
  font).
- Press **L** once for Italian. Press **R** to make sure the title screen is
  showing. Do a 20-second dry start the day before (space, watch two lanes
  turn blue, R).
- Export the backup the day before: **P**, save as PDF, eight pages. If the
  screen share dies, present the PDF and read the beats off it.
- Keys during the talk: **space** pauses and resumes (for a question),
  **← →** jump to the previous or next beat, **R** restarts.

## The ten minutes

Talk time is the small clock. The big clock is the run.

### 0:00 — title screen, before pressing space (about 25 s)

> This is a two-hour job: an integration service for IBM ACE, built from a
> written specification by a flow that nobody supervises. I am going to run
> it in the next nine minutes, at fourteen times the speed. Do not watch me.
> Watch the colours. And count the decisions a person makes. There are two.

Press space.

### 0:00 → 0:13 — spec read, plan drafted

> Eight stories, one lane each. Every lane is the same five steps: a coder,
> the checks, a review, a judge, a merge. The coder is the only step that
> writes code. Everything to its right exists to disagree with it.

### 0:13 — beat 1: the plan is a document

The `you` node is yellow and breathes for thirteen seconds (three minutes of
run time).

> Decision one. The flow wrote a plan: a markdown file, eight stories, their
> order, what counts as done for each. A person reads it, edits it if they
> like, approves it. That is the last time a person touches this run.

At 0:26 the node turns green and three lanes go blue.

### 0:26 → 1:30 — wave 1

> Three coders at a time, each in its own working copy of the repository.
> Nobody is reading what they write. That is not bravery; it is the next two
> columns.

### 1:30 — beat 2: done is not an opinion

S2 `checks` turns red: three tests.

> The coder said done. The build said no. Nothing argues with the coder: its
> report is thrown away, the test output becomes its next input, and it goes
> again. This is the first thing people get wrong about unattended agents:
> they trust the agent's own summary. We never read it.

### 1:45 → 3:04 — first merges

S1 merges at 2:30, S2 at 2:51; S4 and S5 take the freed slots.

> The review seat is a different agent with a different brief: it returns
> findings, never an approval. The judge, next to it, gets one closed
> question.

### 3:04 — beat 3: the judge answers a question

S3 `judge` turns red with `merge? 0.31`.

> "Should this merge?" Not an essay, a probability. There is a threshold.
> Below it, the story goes back to the coder with the findings attached. The
> judge never writes prose, so it cannot talk itself into a yes.

### 3:10 → 4:30 — S3 revises, S4 merges

> What is the person doing right now? Nothing. A human team would be in the
> second hour of its first morning.

### 4:30 — beat 4: long runs lose the thread

S5 `coder` turns orange: context lost at 1h 03m.

> One hour in, a coder drops. Its context is gone; it would not remember what
> it was doing. The lane does not start over: every task it finished was
> checkpointed. Two kept, one redone. Nobody was paged, because there was
> nothing to decide.

### 4:40 → 6:00 — S3 merges, S6 starts, S7 lint red

> The second red on screen is a lint gate. Same mechanism. Nobody explains
> the failure to the coder; the gate's output is the explanation.

### 6:00 — beat 5: the agent is a seat

S8 starts on a local model.

> Look at the seat labels. Four different agents wrote this project, one of
> them a model running on a laptop. The gates, the judge and the plan did not
> change. The method is the seats and what sits between them, not whoever
> sits in them this month.

### 6:05 → 8:51 — the boring part

Everything turns green; `integrate` runs from 8:17.

> This is the part I wanted you to sit through. Nothing happens, and that is
> what unattended means. What were the gates in this project? The build, the
> unit tests, a lint, and a contract check on the message schema. Four
> scripts. Writing them took a morning; they are the whole trick.

If there is a question, press space, answer, press space.

### 8:51 — beat 6: two hours, two decisions

Read the screen.

> Two hours and four minutes. Eight of eight merged. A person wrote the
> spec and approved the plan. Everything else was the flow.

### 9:16 — beat 7: what it is not

> It is not faster thinking: the same work, unattended. It is not a
> substitute for the spec: a wrong spec runs in two hours too. And it is not
> magic: every red node you saw is a gate someone wrote once.

### 9:45 — beat 8: close

> The deck, this replay and this sheet are in the repository. Questions.

## If asked

- **Are those minutes real?** The shape is real: eight stories in waves, a
  rejected story, an interrupted coder, mixed seats, about two hours. The
  minute marks are a reconstruction; the footer says so.
- **What if it never converges?** A story that fails its gates N times is
  parked and a person is asked. That would have been a third decision. It
  did not happen in this run.
- **What does the judge actually see?** The diff, the findings, the test
  output, and one question. It answers with a probability, never a
  paragraph.
- **What did the spec look like?** Two pages of prose and a message schema.
- **Cost?** Not on this screen on purpose. Happy to share numbers after.

## Do not

- Name products other than the coder seats. Do not pitch. Do not say the
  word "replace".
- Click during the run. The point is that you do not have to.
- Skip the boring part. It is the argument.
