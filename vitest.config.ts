import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@llm4ts/core": path.resolve(repositoryRoot, "packages/core/src"),
      "@llm4ts/flow": path.resolve(repositoryRoot, "packages/flow/src"),
      "@llm4ts/runner": path.resolve(repositoryRoot, "packages/runner/src"),
      "@llm4ts/js": path.resolve(repositoryRoot, "packages/js/src"),
      "@llm4ts/shell": path.resolve(repositoryRoot, "packages/shell/src")
    }
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "examples/test/**/*.test.ts",
      "flows/test/**/*.test.ts",
      "kits/**/test/**/*.test.ts"
    ],
    exclude: [".repos/**", "repos/**", "**/node_modules/**"],
    passWithNoTests: true,
    // A developer's own executor roster (~/.config/llm4ts/roster.json) must
    // never reach a test run: tests that want a roster pass one explicitly.
    env: { LLM4TS_ROSTER: "none" },
    reporters: ["dot"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // About two points under the 2026-11-22 figures (90.0% lines, 79.0%
      // branches), so `pnpm test:coverage` fails when coverage drops (review F10).
      thresholds: { lines: 88, statements: 87, functions: 85, branches: 77 },
      include: ["packages/**/src/**/*.ts", "flows/**/*.ts", "kits/**/*.ts"],
      exclude: [
        "**/test/**",
        "**/*.d.ts",
        "**/dist/**",
        // Copies the build puts inside the shell package.
        "packages/shell/flows/**",
        "packages/shell/kits/**",
        // Process entry points: smoke tests run them as child processes,
        // which in-process coverage cannot see.
        "flows/*.ts",
        "kits/*/flows/*.ts",
        "kits/*/tools/**",
        // Ported data and other stacks' templates, not llm4ts code (as in .prettierignore).
        "flows/fixtures/**",
        "kits/*/packs/**",
        "kits/*/patterns/**",
        "kits/*/scaffolds/**",
        "kits/*/fixtures/**"
      ]
    }
  }
})
