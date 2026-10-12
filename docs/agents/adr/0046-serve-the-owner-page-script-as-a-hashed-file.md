# Serve the owner page's Foldkit script as a hashed same-origin file

> **Review:** Agent-only

The owner page becomes a Foldkit application: a model and an update function own the page's
state, views render it, and commands and subscriptions perform its requests and its streamed turn.
esbuild bundles it into one script. The Worker serves that script as its own file from this
origin, behind the same Access check as the page, and the browser keeps it until a release
changes it. The owner chose Foldkit and this delivery on 2026-10-12. Until the Foldkit page
replaces it, the same delivery carries the hand-written script in `src/page/script*.ts`.

**Why a separate file.** The Foldkit spike's bundle was 662,883 bytes, or 208,914 bytes gzip. The
page is `no-store`, because it is rendered for one Access session, so an inline script would be
downloaded again on every load: twenty times the old page. As a separate file it is downloaded
once per release.

**How the Worker serves it.**

- `tools/build-owner-page.mts` (`pnpm build:page`) builds the script and writes the ignored module
  `src/page/owner-script.generated.ts`, which holds the script and its path. The path is
  `/assets/owner-<hash>.js`, where the hash is the first 16 hexadecimal digits of the script's
  SHA-256. One path therefore always means the same bytes.
- The Worker answers `GET` for the current path only, and only after Cloudflare Access
  verification succeeds, so a request without a valid token gets the same 401 as the page. Any
  other path under `/assets/` goes to the active generation like every other request.
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

**Builds.** `pnpm verify` runs `build:page` before the typecheck. `pnpm harness:browser` and
`pnpm test:browser` run it first, and the harness serves the file with the Worker's headers and
policy. Every Wrangler build runs it through `build.command`, which `cf build` and `cf deploy` read
from `wrangler.config.ts` and `wrangler deploy` reads from `wrangler.jsonc`. On a fresh checkout,
run `pnpm build:page` before `pnpm typecheck` or `pnpm test` alone. The page is immutable host
code, not part of a generation's module map.

**Budgets.** `tools/bundle-budgets.test.ts`, in `pnpm test:tools`, measures the Worker upload with
`wrangler deploy --dry-run --containers-rollout=none` and gzips at the default level, which matches
Wrangler's own figure. The limits are the spike's measured end state plus about 10 percent.

| Measurement             | Before the port            | After Wave 0               | Spike end state                   | Limit      |
| ----------------------- | -------------------------- | -------------------------- | --------------------------------- | ---------- |
| Worker upload           | 744.70 KiB / 164.95 KiB gz | 802.87 KiB / 177.70 KiB gz | 1350.84 KiB / 359.99 KiB gz       | 400 KiB gz |
| Owner page script       | inline                     | 30,189 B / 6,808 B gz      | 662,883 B / 208,914 B gz          | 230 KiB gz |
| Page HTML on every load | 44,073 B / 10,274 B gz     | 12,089 B / 2,927 B gz      | 667,286 B / 210,256 B gz (inline) | -          |

**Alternatives.** An inline bundle under the page's nonce needs no new route, but repeats a large
download on every load. Cloudflare static assets can answer before the Worker runs, so they could
skip the Worker's own Access verification, and they would need routing configuration kept equal
across `cloudflare.config.ts` and both Wrangler files. Typed DOM modules without a framework need
fewer dependencies, but the owner chose Foldkit.
