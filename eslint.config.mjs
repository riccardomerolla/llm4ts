import js from "@eslint/js"
import tsPlugin from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import prettierConfig from "eslint-config-prettier"

const importExtensionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require TypeScript extensions for relative imports and none for package imports"
    },
    messages: {
      relativeRequiresTs: "Relative imports must end in .ts: {{source}}",
      relativeNoJs: "Relative imports must use .ts rather than JavaScript extensions: {{source}}",
      packageNoExtension: "Package imports must not include a source extension: {{source}}"
    },
    schema: []
  },
  create(context) {
    const check = (node, source) => {
      if (typeof source !== "string" || source.includes("?")) {
        return
      }

      const relative = source.startsWith("./") || source.startsWith("../")
      if (relative && (source.endsWith(".js") || source.endsWith(".jsx"))) {
        context.report({ node, messageId: "relativeNoJs", data: { source } })
      } else if (
        relative &&
        !source.endsWith(".ts") &&
        !source.endsWith(".tsx") &&
        !source.endsWith(".json")
      ) {
        context.report({ node, messageId: "relativeRequiresTs", data: { source } })
      } else if (
        !relative &&
        (source.endsWith(".ts") ||
          source.endsWith(".tsx") ||
          source.endsWith(".js") ||
          source.endsWith(".jsx"))
      ) {
        context.report({ node, messageId: "packageNoExtension", data: { source } })
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source?.value),
      ImportExpression: (node) => check(node, node.source?.value),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ExportAllDeclaration: (node) => check(node, node.source?.value)
    }
  }
}

const localPlugin = {
  rules: {
    "import-extensions": importExtensionsRule
  }
}

export default [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.repos/**",
      "**/repos/**",
      "**/*.gen.ts",
      // Ported modernization data: pack manifests, pattern cards, and the
      // target-project scaffolds a seeded repository receives. None of it is
      // llm4ts source, and the scaffolds carry other stacks' syntax (JSX).
      "flows/packs/**",
      "flows/patterns/**",
      "flows/fixtures/**",
      "packages/shell/flows/**",
      // Demo-bank fixture repos: standalone toolchains (the Next.js fixture
      // lints itself) and deliberately legacy-styled J2EE content.
      "examples/demo-bank/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["packages/**/*.ts", "examples/**/*.ts", "flows/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      local: localPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "local/import-extensions": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "never"
        }
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports"
        }
      ],
      "no-console": "error",
      "no-redeclare": "off",
      "no-undef": "off",
      "object-shorthand": "error",
      "prefer-const": "error",
      "require-yield": "off"
    }
  },
  {
    files: ["packages/**/test/**/*.ts"],
    rules: {
      "no-console": "off"
    }
  },
  prettierConfig
]
