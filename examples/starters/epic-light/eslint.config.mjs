// Minimal flat config: typescript-eslint recommended plus the house rules.
// `.llm4ts/` holds the flow's state and its story worktrees; `eslint .`
// must not walk into them.
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", ".llm4ts/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "prefer-const": "error"
    }
  }
)
