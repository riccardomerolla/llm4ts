# Epic: epic-light

Add a shared format contract, greet in English or Italian, and keep a click history in the counter; restore the skipped counter test on the way.

## Waves

1. format-contract
2. greeting-locale, counter-history

## Stories

The fixed plan of the light comparison epic against the `epic-light` starter (`examples/starters/epic-light`, seeded by `examples/seed.sh epic`). The block below is the source of truth: the seed drops it at `.llm4ts/epics/epic-light/plan.md`, so a run plans nothing and two releases compare on the same stories. Planted on purpose: `src/platform/clock.test.ts` is red on `main` and no story owns it; `counter.test.ts` skips one test that `counter-history` must restore; `counter-history` cannot meet its acceptance without changing an existing expectation and declares `testsChange: true`.

## Plan block

```json storyplan
{
  "epicId": "epic-light",
  "epic": "Add a shared format contract, greet in English or Italian, and keep a click history in the counter; restore the skipped counter test on the way.",
  "stories": [
    {
      "id": "format-contract",
      "title": "Shared format contract",
      "description": "Create src/contracts/format.ts exporting a `Locale` type (\"en\" | \"it\"), `formatCount(count: number, locale: Locale): string` (\"3 clicks\" / \"3 clic\", singular \"1 click\" / \"1 clic\"), and `formatName(name: string): string` (trimmed, first letter upper-cased). Add src/contracts/format.test.ts covering both locales, the singular, and the name trimming. Follow CONTRIBUTING.md: one describe per module, Vitest imports.",
      "dependsOn": [],
      "owned": ["src/contracts/format.ts", "src/contracts/format.test.ts"],
      "sharedReadOnly": ["CONTRIBUTING.md", "src/features/greeting/greeting.ts"],
      "readFirst": ["src/features/greeting/greeting.ts", "CONTRIBUTING.md"],
      "acceptance": [
        "src/contracts/format.ts exports Locale, formatCount and formatName",
        "formatCount(1, \"en\") is \"1 click\" and formatCount(3, \"it\") is \"3 clic\"",
        "src/contracts/format.test.ts exists and covers both locales and formatName"
      ],
      "provides": ["Locale, formatCount, formatName from src/contracts/format.ts"]
    },
    {
      "id": "greeting-locale",
      "title": "Greeting in English or Italian",
      "description": "Extend src/features/greeting/greeting.ts so `greet(name, locale)` takes a `Locale` from src/contracts/format.ts and answers \"Hello, <Name>!\" in English or \"Ciao, <Name>!\" in Italian, passing the name through `formatName`. Keep the existing one-argument call working (English by default). Extend greeting.test.ts with the Italian case and the default.",
      "dependsOn": ["format-contract"],
      "owned": ["src/features/greeting"],
      "sharedReadOnly": ["src/contracts", "CONTRIBUTING.md"],
      "readFirst": ["src/contracts/format.ts", "src/features/greeting/greeting.ts"],
      "acceptance": [
        "greet(\"ada\", \"it\") is \"Ciao, Ada!\" and greet(\"Ada\") is still \"Hello, Ada!\"",
        "greeting.test.ts covers the Italian greeting and the default locale",
        "nothing outside src/features/greeting changes"
      ],
      "provides": ["greet(name, locale?) from src/features/greeting/greeting.ts"]
    },
    {
      "id": "counter-history",
      "title": "Counter with click history",
      "description": "Give the counter in src/features/counter/counter.ts a `history: ReadonlyArray<number>` of every count it has had (make() starts with [0]; increment and reset append). Un-skip the \"resets to zero\" test in counter.test.ts and make it pass; update the \"starts at zero\" expectation to the new shape and add a test for the history. Then update src/app.ts (the composition point this story owns) so `run(name, locale)` greets through greet(name, locale) and renders the count with formatCount from src/contracts/format.ts.",
      "dependsOn": ["format-contract"],
      "owned": ["src/features/counter", "src/app.ts"],
      "sharedReadOnly": ["src/contracts", "src/features/greeting", "CONTRIBUTING.md"],
      "readFirst": ["src/features/counter/counter.ts", "src/contracts/format.ts", "src/app.ts"],
      "acceptance": [
        "make().history is [0] and increment(make()).history is [0, 1]",
        "counter.test.ts has no it.skip and its reset test passes",
        "run(\"ada\", \"it\") contains \"Ciao, Ada!\" and \"1 clic\""
      ],
      "provides": ["Counter.history from src/features/counter/counter.ts", "run(name, locale) from src/app.ts"],
      "testsChange": true
    }
  ]
}
```
