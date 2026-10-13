import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "node_modules",
    "dist",
    ".wrangler",
    ".agents/**",
    "tools/oxlint/anti-slop/**",
    "vendor/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "foldkit", specifier: "@foldkit/oxlint-plugin" },
    { name: "cf-stumble", specifier: "./tools/oxlint/cf-stumble/index.ts" },
  ],
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
    // `anti-slop/require-readable-spacing` mandates blank lines. At 541a484, turning it on
    // pushed 15 files and 12 functions over their physical-line limits without adding content; all
    // 23 affected paths stay within these budgets when blank lines do not count. Splitting them
    // would add interfaces and imports without hiding complexity. The measured 275/48 alternative
    // would reproduce the snapshot's tightest content budget, but changing the maxima is a separate
    // decision and would leave almost no headroom. `skipComments` stays false because comments are
    // content a reader must understand. See ADR-0041.
    "eslint/max-lines": ["warn", { max: 300, skipBlankLines: true, skipComments: false }],
    "eslint/max-lines-per-function": [
      "warn",
      { max: 50, skipBlankLines: true, skipComments: false },
    ],
    "eslint/no-console": "off",
    "unicorn/prefer-top-level-await": "off",
    "unicorn/no-null": "off",

    // Import Effect by module path (`effect/Effect`), not from the `effect` index. The index
    // re-exports every module, so each workers test isolate loaded all of them (1.3 s instead of
    // 0.36 s, before the prebundle in vitest.config.ts), and its side-effect list keeps some unused
    // modules in the Worker bundle.
    "eslint/no-restricted-imports": [
      "error",
      { paths: [{ name: "effect", message: "Import the module path, such as effect/Effect." }] },
    ],

    // The default of 1 assumes a class is a whole module's worth of concept. That holds for a
    // stateful class and fails for test doubles, where a file defines one small class per
    // collaborator (`test/workspace/project/fakes.ts` has five). A ceiling still catches a real
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
    // At 541a484, all 2,325 sites across 261 files were fixed by inserting blank lines only. Six
    // independent readers reviewed every insertion and objected to 78, or 3.4 percent, all in
    // compact groups that the rule spread out. None is suppressed: the rule has no options, the
    // vendored plugin stays verbatim, and a disable comment with a reason is louder than the blank
    // line it would remove. ADR-0041 records the measured cost and decision.
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // A `typeof` check inside a type guard is the guard's whole job. The parsers that read
    // untrusted JSON keep their checks; everywhere else the rule stays on.
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],

    // Workers RPC exposes every prototype method of an RPC class, whatever TypeScript calls it.
    "cf-stumble/no-typescript-private-rpc-member": "error",
  },

  overrides: [
    {
      // The owner page's Foldkit program. Effect and Foldkit name a tagged union's discriminant
      // `_tag`, and a Schema is declared as a value and a type with one name
      // (`export const Model = Schema.Struct(...)` and `export type Model = typeof Model.Type`).
      files: ["src/page/client/**", "test/page/client/**"],
      rules: {
        "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
        "eslint/no-redeclare": "off",
        // Effect's `Option.some`, `Option.map`, and `Array.map` are module functions, not array
        // methods, and their arguments are values or callbacks of a known arity. The rule reads
        // every `.some(` and `.map(` as an array method once Effect is imported by module path.
        // Host code keeps the rule: it calls `.map` on real arrays far more often than it imports
        // `effect/Option`, so an Effect call there wraps its callback or takes a disable comment.
        "unicorn/no-array-callback-reference": "off",
      },
    },
    {
      // Foldkit's own rules, for the page program only: its tests build Messages and Models by
      // hand on purpose. Every rule the pinned plugin ships is listed, so an upgrade cannot add one
      // unread (tools/foldkit-lint.test.ts).
      files: ["src/page/client/**"],
      rules: {
        "foldkit/acquire-release-constructs-in-acquire-body": "error",
        "foldkit/command-binding-matches-name": "error",
        "foldkit/command-define-pascal-const": "error",
        "foldkit/got-prefix-requires-submodel-payload": "error",
        "foldkit/got-submodel-message-name": "error",
        "foldkit/got-wrapper-carries-only-routing": "error",
        "foldkit/keyed-required-for-mapped-rows": "error",
        "foldkit/lazy-view-stable-references": "error",
        "foldkit/mount-factory-must-use-element": "error",
        "foldkit/no-array-index-view-keys": "error",
        "foldkit/no-child-message-construction-in-root": "error",
        "foldkit/no-direct-submodel-state-update": "error",
        "foldkit/no-disabling-dev-guardrails": "error",
        "foldkit/no-duplicate-onmount-per-element": "error",
        "foldkit/no-empty-children-array": "error",
        "foldkit/no-empty-commands-array": "error",
        "foldkit/no-empty-to-parent-out-message": "error",
        "foldkit/no-empty-object-tagged-call": "error",
        "foldkit/no-hand-rolled-command-struct": "error",
        "foldkit/no-impure-call-at-decision-time": "error",
        "foldkit/no-module-level-mutable-state": "error",
        "foldkit/no-noop-message": "error",
        "foldkit/no-prevent-default-in-stream-operator": "error",
        "foldkit/no-raw-dom-event-attributes": "error",
        "foldkit/no-route-query-constructor-default": "error",
        "foldkit/no-spread-in-modify-fields": "error",
        "foldkit/no-switch-on-message-tag": "error",
        "foldkit/prefer-callable-message-constructor": "error",
        "foldkit/prefer-command-mapmessage": "error",
        "foldkit/prefer-effect-module-names": "error",
        "foldkit/prefer-option-over-nullable-in-model": "error",
        "foldkit/require-fold-for-child-update-result": "error",
        "foldkit/require-rel-for-external-link": "error",
        "foldkit/selection-submodel-factory-at-module-scope": "error",
        "foldkit/wrap-child-output-in-got-message": "error",
        // Off: the page has no Router. Its one link reloads the page itself.
        "foldkit/no-hardcoded-route-strings": "off",
        // Off: the page has no server target.
        "foldkit/no-nonportable-server-globals": "off",
      },
    },
    {
      // `node:test` registers `describe` and `it` and tracks their promises itself; awaiting each
      // one at the top level would serialize the tests for no gain.
      // Test-local helper closures stay next to the test that uses them.
      files: ["tools/ops-check/**/*.test.ts", "tools/*.test.ts"],
      rules: {
        "typescript/no-floating-promises": "off",
        "unicorn/consistent-function-scoping": "off",
      },
    },
  ],

  // The vendored copy also ships an opt-in `anti-slop-effect` plugin: no-manual-effect-error-tag,
  // no-manual-tag-comparison, no-manual-tagged-construction, no-service-constructor-imports and
  // prefer-effect-match. It stays unregistered. Its rules are not gated on an Effect import, and
  // after the port they report only code that is right as it is: on `src` they find three chained
  // literal ternaries in plain functions (prefer-effect-match) and eleven one-line `_tag` checks in
  // the page's predicates (no-manual-tag-comparison), and nothing else. Foldkit's plugin already
  // rejects a `switch` on a Message's tag in the page.
});
