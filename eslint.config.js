import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Express identifies an error handler by its four arguments, and room
      // callbacks often take unused ones: an underscore prefix opts out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": "warn",
    },
  },
  {
    // Application and test code: the AI_RULES.md bans apply here.
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "AI_RULES.md: no default exports. Use a named export.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "AI_RULES.md: never call Math.random. Use the seeded provably fair generator in src/lib/fair-rng.ts.",
        },
        {
          selector: "TSAnyKeyword",
          message: "AI_RULES.md: the `any` type is not allowed.",
        },
      ],
    },
  },
  {
    files: ["src/lib/env.ts", "src/index.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
