import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "node_modules",
    "dist",
    ".wrangler",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    "prototypes/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  plugins: ["typescript", "unicorn", "oxc", "import"],
  categories: {
    correctness: "error",
    suspicious: "error",
    pedantic: "warn",
  },
  rules: {
    "typescript/no-explicit-any": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/prefer-readonly-parameter-types": "off",
    "eslint/no-console": "off",
    "unicorn/prefer-top-level-await": "off",
    "unicorn/no-null": "off",

    // Clean on adoption — enforced immediately.
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",

    // Violated on adoption. Ratcheted to "error" as each is cleared, so the gate never goes
    // red and no violation is silently tolerated. Counts are from the adoption run.
    // 58 violations on adoption
    "anti-slop/no-unknown-parameters": "off",
    // 40 violations on adoption
    "anti-slop/no-runtime-typeof": "off",
    // 22 violations on adoption
    "anti-slop/no-unsafe-dictionary-type": "off",
    // 8 violations on adoption
    "anti-slop/no-known-value-widening": "off",
    // 4 violations on adoption
    "anti-slop/no-unknown-returns": "off",
    // 2 violations on adoption
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    // 1 violations on adoption
    "anti-slop/no-object-parameters": "off",
    // 1 violations on adoption
    "anti-slop/no-chained-type-assertions": "error",
  },
});
