// Minimal flat config: typescript-eslint recommended plus the house rules.
// No framework plugin zoo — the hard gates are typecheck, lint, test, build;
// the house style lives in CONTRIBUTING.md and the exemplar feature.
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    // `.llm4ts/` holds the flow's state and its story worktrees (each with
    // its own dist/ and node_modules/); `eslint .` must not walk into them.
    ignores: ["**/node_modules/", "**/dist/", "contracts/openapi/", ".llm4ts/"]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "prefer-const": "error"
    }
  }
)
