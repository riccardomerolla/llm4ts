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
      "@llm4ts/modernize": path.resolve(repositoryRoot, "packages/modernize/src"),
      "@llm4ts/js": path.resolve(repositoryRoot, "packages/js/src"),
      "@llm4ts/shell": path.resolve(repositoryRoot, "packages/shell/src")
    }
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "examples/test/**/*.test.ts",
      "flows/test/**/*.test.ts"
    ],
    exclude: [".repos/**", "repos/**", "**/node_modules/**"],
    passWithNoTests: true,
    reporters: ["dot"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/**/src/**/*.ts"],
      exclude: ["packages/**/test/**", "**/*.d.ts"]
    }
  }
})
