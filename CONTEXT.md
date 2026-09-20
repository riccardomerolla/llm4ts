# llm4ts

The Effect-TS engine that runs LLM-driven flows (planning, coding, review,
modernization) over connectors to API providers and CLI coding agents.

## Language

### Judgment

**Judgment**:
The act of asking a backend to evaluate typed questions against one State and
return typed answers with probabilities, instead of generated text. Also the
name of the service that performs it.
_Avoid_: Jev, System One, oracle, verdict

**State**:
The content a Judgment evaluates: a string, a JSON object, or an array of
texts. It is data, never instructions.
_Avoid_: context, input, prompt

**Question**:
One atomic, well-scoped thing asked about a State. A request carries many
Questions over one State; each is answered independently of the others.
_Avoid_: rubric, dimension, criterion

**Choice**:
A Question that selects one option from an unordered set. Its answer is the
chosen option key, a probability per option, and a Confidence.
_Avoid_: classification, pick, enum question

**Score**:
A Question that places the State on an ordered scale of described levels. Its
answer is a position (possibly between two levels), a probability per level,
and a Confidence.
_Avoid_: rating, grade, rubric score

**Truth**:
A Question that evaluates a yes/no statement. Its answer is the probability
that the statement holds.
_Avoid_: Noul, boolean question, assertion, predicate

**Confidence**:
A statistic in [0, 1] derived from an answer's probability distribution:
concentrated means confident, spread out means uncertain. It is not a
probability of being correct.
_Avoid_: certainty, accuracy

**Origin**:
Where an answer came from, as four separate facts: the backend and
checkpoint that produced it, the Method that extracted the probabilities,
the Calibration evidence behind them, and whether it replaced an earlier
answer by escalation.
_Avoid_: provenance (that is the modernization manifest), source

**Method**:
How an answer's probabilities were extracted: read from token
log-probabilities, written by the model itself (verbalized), estimated by
repeated sampling, decoded from a reasoning model's typed reply, or returned
by a hosted judgment service.
_Avoid_: provenance, path

**Calibration**:
What is known about whether an answer's probabilities match outcomes: none,
claimed by the provider, or measured by an evaluation in this project.
_Avoid_: accuracy, trust

**Support**:
The share of probability mass a backend actually placed on the offered
options before renormalization. An answer rebuilt from a sliver of mass is
held regardless of its Confidence.
_Avoid_: coverage, mass

### Existing evaluation terms (kept distinct from Judgment)

**Judge**:
An LLM-as-judge evaluator that scores a sample against rubric dimensions
(`eval/Judge`), or the program-level spec-compliance gate (`ProgramJudge`).
Not a Judgment: it generates scored findings rather than answering typed
Questions.
_Avoid_: verifier, grader

**Reviewer**:
A review lens that produces structured findings from a diff.

**Gate**:
A step that turns a check (shell command, coverage rule, judge, lint) into a
review result and can abort the flow when it is not clean.
