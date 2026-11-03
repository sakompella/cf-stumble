# Gate the Worker with HTTP Basic auth

> **Review:** Human-approved

On 2026-10-30 Aditya removed Cloudflare Access and left the Worker open: anyone who found the
hostname could run turns, which use the GitHub token and cost container time. On 2026-11-03 he
chose HTTP Basic auth as the gate until a real login exists.

**Every request except `GET /health` needs the owner's Basic credential.** The user name is
`aditya` and the password is the Worker secret `OWNER_PASSWORD`, which the Alchemy stack never
declares. `src/owner-gate.ts` runs before any route. It hashes the expected and the presented
credential with SHA-256 and compares the digests with `crypto.subtle.timingSafeEqual`, so the
comparison takes the same time whatever the password's length or content. A missing or wrong
credential answers 401 with a Basic challenge. A Worker without the secret answers 503, so a fresh
deploy is closed rather than open. The exempt routes are one list in that file.

**A state-changing request must come from the Worker's own origin.** With a valid credential, a
request other than `GET` or `HEAD` answers 403 `cross-origin-request` when its `Origin` names
another origin or its `Sec-Fetch-Site` is not `same-origin`. A browser sends cached Basic
credentials with a cross-site form post, so the credential alone does not stop cross-site request
forgery. A request with neither header, such as `curl`, passes on the credential.

**Why Basic auth.** It needs no session store, no cookie, and no change to the page: the browser
asks once and sends the credential with every same-origin `fetch` and `EventSource`. Cloudflare
Access needs a separate policy and an identity provider for one person. Basic auth has no logout,
no second factor, and one shared password; rotating the secret is the only revocation.

**What replaces it.** A login that issues a session, through Cloudflare Access or GitHub sign-in,
when a second person or device needs separate access. That change replaces `src/owner-gate.ts` and
keeps the same-origin check.
