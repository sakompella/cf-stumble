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
    "vendor/**",
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

    // anti-slop is vendored from dmmulroy/anti-slop at tools/oxlint/anti-slop. Every generic rule
    // the vendored version ships is listed here, enforced or off with its count and reason, so a
    // re-vendor cannot add a rule this project never decided about.

    // Enforced.
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // A `typeof` check inside a type guard is the guard's whole job. The parsers that read
    // untrusted JSON keep their checks; everywhere else the rule stays on.
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],

    // Off, with the count from the re-vendor run.
    //
    // 2322 violations across 261 files. This rule inserts blank lines, and `--fix` clears every
    // one of them, but the result puts 27 files over eslint(max-lines) and
    // eslint(max-lines-per-function), which are errors under `--max-warnings=0`. Enforcing it
    // therefore means splitting 27 files, and a 261-file whitespace diff during a release
    // collides with every branch in flight. Formatting here belongs to oxfmt.
    "anti-slop/require-readable-spacing": "off",
  },

  // The vendored copy also ships an opt-in `anti-slop-effect` plugin: no-manual-effect-error-tag,
  // no-manual-tag-comparison, no-manual-tagged-construction, no-service-constructor-imports and
  // prefer-effect-match. It is deliberately not registered. This project uses better-result, not
  // Effect (ADR 0035), and those rules are not gated on an Effect import: prefer-effect-match
  // already reports one chained ternary in test/workspace/project/fakes.ts and demands an Effect
  // `Match` that nothing here can import. Upstream registers this group only in Effect projects.
});
