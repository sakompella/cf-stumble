# Serve the owner page's Foldkit script as a hashed same-origin file

> **Review:** Agent-only

The owner page becomes a Foldkit application: a model and an update function own the page's
state, views render it, and commands and subscriptions perform its requests and its streamed turn.
esbuild bundles it into one script. The Worker serves that script as its own file from this
origin, and the browser keeps it until a release changes it. The program lives in
`src/page/client`, and the served HTML holds only its container.

**Why a separate file.** The Foldkit bundle is about 635 KB, or 200 KB gzip. The
page is `no-store`, so an inline script would be downloaded again on every load. As a separate
file it is downloaded once per release.

**How the Worker serves it.**

- `tools/build-owner-page.mts` (`pnpm build:page`) builds the script and writes the ignored module
  `src/page/owner-script.generated.ts`, which holds the script and its path. The path is
  `/assets/owner-<hash>.js`, where the hash is the first 16 hexadecimal digits of the script's
  SHA-256. One path therefore always means the same bytes.
- The Worker answers `GET` for the current path only. Any other path under `/assets/` goes to the
  active generation like every other request.
- The script's response carries `content-type: text/javascript; charset=utf-8`,
  `cache-control: public, max-age=31536000, immutable`, `x-content-type-options: nosniff`, and
  `content-security-policy: default-src 'none'; frame-ancestors 'none'`. `public` is safe because
  the script holds no identity, credential, or owner data: every owner receives the same bytes,
  built from the repository.
- The page keeps `cache-control: no-store` and its per-response nonce, which now admits only the
  inline stylesheet. Its policy is `script-src 'self'`, and nothing in it allows `'unsafe-inline'`
  or `'unsafe-eval'`. Foldkit's optional Schema JIT compiler needs eval and stays off.

`script-src 'self'` also admits any script the active generation serves on this origin. The page
cannot be made to load one, because it creates no script element and renders model and repository
output only as text. A source pinned to the exact path would be stricter, but it needs the request
origin in the policy, and the page's own guarantees already close the gap.

**Builds.** `pnpm verify` runs `build:page` before the typecheck. `pnpm test:browser` runs it first,
and the stub server serves the file with the Worker's headers and
policy. Every Worker build runs it through the `build.command` in `wrangler.config.ts`, which
`cf build` and `cf deploy` read through Wrangler. On a fresh checkout,
run `pnpm build:page` before `pnpm typecheck` or `pnpm test` alone. The page is immutable host
code, not part of a generation's module map.

**Budgets.** `tools/bundle-budgets.test.ts`, in `pnpm test:tools`, measures the Worker upload with
`wrangler deploy --dry-run --experimental-new-config --containers-rollout=none` and the page script, both gzipped, and fails
above its limits. The limits sit about 10 percent above the measured sizes. The real constraint on
the Worker is startup time, which only a staged deploy measures.

**Alternatives.** An inline bundle under the page's nonce needs no new route, but repeats a large
download on every load. Cloudflare static assets would need routing configuration
in `cloudflare.config.ts`. Typed DOM modules without a framework need
fewer dependencies, but the owner chose Foldkit.
