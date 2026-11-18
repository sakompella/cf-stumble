# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (v0.1.2 plus the merge of PR #45). This is the upstream `main` head as of 2026-11-18.

This directory holds upstream `src/` and the root `LICENSE`. The upstream `src/vendor/eslint-stylistic` directory is `vendor/eslint-stylistic` here and has its own `UPSTREAM.md`.

## Local edits

Two test files differ from upstream. Both edits remove coverage of paths that this repository's configuration cannot reach, so a re-vendor must re-apply them:

- `rules/require-readable-spacing-cli.test.ts` drops the `rejected` and `clean` invocations of the CLI smoke test (commit cbce4fb0).
- `rules/require-readable-spacing.test.ts` drops the second `tester.run` over the padding factory's `blankLine: "never"` mode and its import. The public rule exposes no option that reaches that mode (commit aec3c367).

Every other file is byte-identical to upstream at the commit above.

## Updating and verification

1. Compare every file here with the same path in the new upstream commit. The base is the commit where all shared files match, apart from the two test files.
2. Replace the files, re-apply the local edits, and keep both `LICENSE` files.
3. Run each upstream test with `tsx` (the list is the `test` script in upstream `package.json`), then `pnpm test:tools` and `pnpm lint`.
4. Upstream pins `oxlint` and `@oxlint/plugins` to 1.78.0. This repository resolves a newer version of both and the tests pass on it.

The directory is excluded from lint, format and the tools type check, so run these checks by hand after a re-vendor.
