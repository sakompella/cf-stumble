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

    // The default of 1 assumes a class is a whole module's worth of concept. That holds for a
    // stateful class and fails for a tagged-error family, where each variant is a few lines and
    // the family read together *is* the design — splitting `src/tools/errors.ts` into nine files
    // would hide the failure taxonomy to satisfy a count. A ceiling still catches a real
    // grab-bag; only the default of 1 is wrong here.
    "eslint/max-classes-per-file": ["warn", { max: 12 }],

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
    "anti-slop/no-unknown-parameters": "error",
    // 40 violations on adoption
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    // 22 violations on adoption
    "anti-slop/no-unsafe-dictionary-type": "error",
    // 8 violations on adoption
    "anti-slop/no-known-value-widening": "error",
    // 4 violations on adoption
    "anti-slop/no-unknown-returns": "error",
    // 2 violations on adoption
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // 1 violations on adoption
    "anti-slop/no-object-parameters": "error",
    // 1 violations on adoption
    "anti-slop/no-chained-type-assertions": "error",
  },
});
