# The nine criteria against the deployed owner instance

Written at `main` `40bd19a`. Evidence paths are relative to the repository root. "Deployed" means
the owner's own instance at `stumble.akompella.dev`, behind his real Cloudflare Access application,
verified with his real identity.

## 1. Release commit and release notes — NOT MET, one merge away

`pnpm verify` is green at the release commit: 110 test files, 784 tests. `pnpm harness:browser` is
green: 41 cases. The notes themselves are being written now and are not merged, so the criterion
is not met. Everything they must state is measured and in `docs/release/v0/evidence/`.

## 2. Access admits only the owner — MET, with one gap named

Met: the Worker received the owner's real Access token and answered `admitted` for
`sub 3eb1d2b2-2e13-5243-ba1b-147f5bd3c2a1`, issuer `adityakompella.cloudflareaccess.com`, his
application's audience, against Cloudflare's own signing keys with no injected JWKS. An
unauthenticated request gets 302 to Access and never reaches the Worker. With `CF_ACCESS_*` unset
or partial, every route refuses, 401 without a credential and 500 with one.
Evidence: `docs/release/v0/evidence/access-and-route.md`.

Authenticated owner requests reach all five things the criterion lists: the Supervisor
(`/api/status`), the connected project and the shared workspace (`/api/projects`, and a turn that
listed `/workspace`), generation state (the drawer reads label 2 at epoch 5), and the saved thread
(it survived a reload with its tool calls and diff).

The gap: **that a non-owner is refused is proved by unit test, not deployed.** No second verified
identity has ever been presented to this deployment. Closing it needs a second Access identity.

## 3. One connected GitHub repository — MET

`/api/projects` returns `sakompella-emaily-demo` beside the harness, with
`github: {state: connected, login: sakompella, source: configured-token}`. A turn listing the
container showed `/workspace/AGENTS.md`, `/workspace/harness` at `ffdde44`, and
`/workspace/projects/sakompella-emaily-demo` at its own HEAD `d500087`, so one workspace holds both
repositories and `git` works in each. The credential never appears in a tracked file, a log, a
response or saved state: the credential path is forbidden to log by
`test/github/credential-surfaces.test.ts`, and the token now reaches `gh` on standard input and
touches no filesystem at all.

## 4. The page and one real turn — PARTLY MET

Met: the page has the sidebar and the streaming conversation, driven against the deployment in a
real browser. A deployed turn read `README.md`, wrote to it, ran a command, and streamed
`tool-start`, `tool-result`, `text` and `diff` frames before `saved`.

Not met, precisely: the command that turn ran was `git diff --stat`, not the repository's own
configured check. Nothing has run a project's check suite in the container. One turn from the page
closes this.

## 5. One thread, one active turn, instructions, fresh thread — PARTLY MET

Met deployed: one current thread per project, saved across turns and reloads, and one active turn
at a time. The page refused to start a second turn while one was live, and `wrangler tail` showed
no second request, so the lease and the page guard both hold.

Not met: the managed instructions file exists at `/workspace/AGENTS.md`, but that its contents
reach Pi's prompt is proved only by `test/docs/managed-instructions.test.ts`, not deployed. Fresh
thread has never been exercised deployed.

## 6. What counts as a completed turn, and lease fencing — MET by test, as written

The criterion asks for tested lease fencing, and the tests exist, including two Hegel properties
added in the bounded test pass and mutation-checked: an active turn holds the thread until its
deadline, and only the lease a row holds can finish or abandon the turn it admitted. Deployed
turns saved monotonic revisions.

## 7. Generation swap and rollback — MET

All of it deployed, with raw responses in `docs/release/v0/evidence/deployed-generation-loop.md`:
a commit built and cold-checked to `ready` in 321 s, activated in 0.4 s with the observed epoch, a
stale epoch refused with `stale-epoch`, the same conversation continuing afterwards, a deliberately
broken candidate recorded `response-rejected` and `failed` while the active generation kept
serving, rollback in **0.26 s** with no Workspace Host call at all, and a repeated submission
returning the existing generation.

## 8. No local fake in the deployed proof — MET

Every claim above is a response from the deployed Worker on the paid account. The browser harness
stub proves the page against a fixture, and it is named as such; the page was separately driven
against the deployment itself.

## 9. Recording, with the probe output and notes — NOT MET, and it is the human's

The recording is the owner's work and does not exist yet. The other half is now satisfied in
advance: the paid probe output lives in `docs/release/v0/evidence/`, tracked, so it survives a
fresh clone and sits beside the notes rather than in gitignored `.audit/`.

## Summary

Met: 3, 7, 8, and 2 and 6 as written. Partly met: 4 and 5, each with one named deployed gap.
Not met: 1, one merge away, and 9, which is the recording.
