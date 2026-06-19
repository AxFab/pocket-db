// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * ESLint flat configuration for Pocket DB.
 *
 * - Library source (`src/`) is held to the strict typescript-eslint rules.
 * - Tests are linted with the same base but a few rules relaxed, since they
 *   legitimately use `any` casts (to reach internals) and non-null assertions
 *   on fixtures.
 *
 * Run with `npm run lint` (or `npm run lint:fix` to autofix).
 */
export default tseslint.config(
  // Never lint build output, deps, or the benchmarks sub-workspace (own
  // package, not part of the published library — same convention as expediate).
  {
    ignores: ["dist/**", "node_modules/**", "benchmarks/**"]
  },

  // Base JS + TypeScript recommended rule sets.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide language options and shared rule tweaks.
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Allow intentionally unused identifiers prefixed with `_`
      // (e.g. `_document`, `_definition`, destructured `_meta`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ]
    }
  },

  // Relaxations for tests.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  }
);
