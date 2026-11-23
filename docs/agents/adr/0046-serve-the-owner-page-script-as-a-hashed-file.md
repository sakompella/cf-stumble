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
- The page keeps `cache-control: no-store` and its per-response nonce, which admits the inline
  stylesheet and the scripts Cloudflare injects (below). Its policy is `script-src 'self'` plus that
  nonce plus `https://static.cloudflareinsights.com/beacon.min.js/`, and nothing in it allows
  `'unsafe-inline'` or `'unsafe-eval'`. Foldkit's optional Schema JIT compiler needs eval and stays off.

**Scripts Cloudflare injects.** The zone's JavaScript Detections add an inline script to every HTML
response. It carries the request's ray ID, so a hash cannot name it. Cloudflare reads a nonce from
the `script-src` of the response's policy and stamps it on that script, so the page's one nonce
covers it. The Web Analytics beacon loads from `static.cloudflareinsights.com/beacon.min.js/<version>`
and reports to this origin's `/cdn-cgi/rum`, which `connect-src 'self'` already admits. The source
ends in a slash so that it matches the versioned path. The page serves its favicon at `/favicon.svg`
from its own origin.

`script-src 'self'` also admits any script the active generation serves on this origin. The page
cannot be made to load one, because it creates no script element and renders model and repository
output only as text. A source pinned to the exact path would be stricter, but it needs the request
origin in the policy, and the page's own guarantees already close the gap.

**Builds.** `pnpm verify` runs `build:page` before the typecheck. `pnpm test:browser` runs it first,
and the stub server serves the file with the Worker's headers and
policy. `pnpm run deploy` runs it before Alchemy bundles the Worker. On a fresh checkout,
run `pnpm build:page` before `pnpm typecheck` or `pnpm test` alone. The page is immutable host
code, not part of a generation's module map.

**Budgets.** `tools/worker-startup.test.ts` builds the Worker as Alchemy uploads it (`buildWorkerBundle()` in
`infra/worker-bundle.ts`, Rolldown, source maps left out), gzips each file and fails above 700 KiB.
`tools/bundle-budgets.test.ts` does the same for the page script, with a limit of 256 KiB. Both run in
`pnpm test:tools`. On 2026-11-17 the upload was 443,251 bytes gzip and the page script 246,755 bytes.
The Worker limit sits 62 percent above the upload and guards against a sudden jump in size. The real
constraint on the Worker is startup time, which only a staged deploy measures. An earlier version of
the test measured an esbuild bundle of `src/worker.ts`, which was 13 percent larger than the upload.

**Alternatives.** An inline bundle under the page's nonce needs no new route, but repeats a large
download on every load. Cloudflare static assets would need routing configuration
in the Worker configuration. Typed DOM modules without a framework need
fewer dependencies, but the owner chose Foldkit.

**Amendment (2026-11-23): the Pierre renderer script and its policy.** Aditya chose Pierre's
libraries for the transcript. Assistant replies render with `@pierre/words` 0.3.0, whose
`@pierre/highlights` 0.5.2 plugin colours code blocks. A tool output that looks like a unified
diff, and the patch that the edit tool puts in its result details, render with `@pierre/diffs`
1.7.0-beta.5 (`DiffHunksRenderer`, the Highlights backend, word-level line diffs). The
hand-written Markdown parser is gone.

- `pnpm build:page` first builds `src/page/client/pierre/entry.ts` as one ES module and writes it
  as a static asset, `build/shell-assets/assets/pierre-<hash>.js` (the hash rule above), and its
  path into the ignored `src/page/pierre-script.generated.ts`. The Worker does not embed it: for
  that one path it reads the file through the `ASSETS` binding and answers with the page script's
  headers (`immutable`, `nosniff`, the asset policy). Assets run behind the Worker
  (`runWorkerFirst`), so the owner gate covers the file, and no other asset path is answered.
- The page script imports it with `import()` when the first `stumble-markdown` or `stumble-diff`
  element connects. Both elements are defined in the page script; Foldkit sets their properties, so
  a row keeps its element and the reply in progress is patched in place. Until the script arrives,
  a reply shows its source as plain text. The diff element keeps the output text as its children
  and covers them with a shadow root only when the text parses as a patch; text before the patch,
  such as the commit header of `git show`, stays above the diff.
- The build replaces the Shiki backend, Shiki's catalogs, and the theme catalogs of
  `@pierre/theming` and `@pierre/highlights` with an empty module, and resolves `@pierre/words`
  to `@pierre/words/no-math`. The page selects the Highlights backend and registers Pierre Light and
  Pierre Dark itself, so those dynamic imports never run; without the replacement esbuild inlines
  them and the file grows from 341 KB to 583 KB gzip.
- Policy, tested in Chromium 158 against the libraries' real output:

  | Policy                                   | Result                                                                                                                    |
  | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
  | before                                   | `@pierre/words` throws at import: compiling WebAssembly needs `'wasm-unsafe-eval'`                                        |
  | `script-src` + `'wasm-unsafe-eval'`      | renders; token colours and table alignment (`style` attributes) and the theme `<style>` element of `FileDiff` are blocked |
  | stylesheets through `adoptedStyleSheets` | not blocked: Words' stylesheet, the diff core and theme CSS load this way, so `style-src` keeps only its nonce            |
  | a nonce                                  | cannot apply: nonces admit elements, and the colours are `style` attributes, which neither library can emit as classes    |
  | + `style-src-attr 'unsafe-inline'`       | renders with colours, no violation                                                                                        |

  The policy therefore adds `'wasm-unsafe-eval'` to `script-src` and `style-src-attr
  'unsafe-inline'`. The first admits compiling WebAssembly, not `eval` of script. The second admits
  `style` attributes only: no `<style>` element and no stylesheet, so injected markup could not add
  selectors. `FileDiff` is not used because its theme `<style>` element would need
  `style-src-elem 'unsafe-inline'`.

- The page now writes HTML that Words built from model text. Words has no mode that escapes raw
  HTML, only one that drops it, so the page puts a word joiner (U+2060) after every `<` that could
  open a tag before Words parses the text, and removes it again from the rendered text and from the
  code it highlights. Raw HTML therefore shows as its literal text, as with the earlier parser, and
  Words still omits any that reaches it. Words checks URL schemes; the page's options also keep
  only `http(s)` links and drop images, which `img-src` would block.
  `test/page/client/markdown.props.test.ts` checks the output for allowed elements and attributes
  and `http(s)` links, and that `<b>x</b>` shows as text. The page still creates no script element;
  `import()` loads only the fixed path.
- Budgets: the page script is 251,936 bytes gzip (limit 256 KiB), the Pierre asset 341,081
  (limit 383 KiB, `tools/bundle-budgets.test.ts`), and the Worker upload 453,155 (limit 700 KiB,
  unchanged).
