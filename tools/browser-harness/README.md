# Browser harness

`pnpm harness:browser` starts a local owner API stub, serves the real owner page from `src/page`,
and drives headless Chrome through the DevTools Protocol. It runs every case in `cases/`, each in
its own stub server and its own tab, and prints one line per case with the evidence that case
gathered.

It does not test Cloudflare Access. Access needs a deployed environment.

## Run it

```sh
export CF_STUMBLE_CHROME="$(command -v chromium)"
pnpm harness:browser                 # every case
pnpm harness:browser --only chat     # one surface
pnpm harness:browser --only CHAT-2   # one case
pnpm harness:browser --only smoke    # the fast plumbing check
pnpm harness:browser --list          # what is registered
```

`CF_STUMBLE_CHROME` names the Chrome, Chromium, or Edge executable to launch. Set it when browser
discovery cannot find the right binary. The harness also searches the Playwright cache and common
system paths.

This is outside the commit gate. It needs a local Chromium and about half a minute for the chat
surface, and `pnpm verify` has to stay fast enough to run before every commit. `--only smoke` is
the fast check that the harness itself still works.

## Write a case

Read [CASES.md](./CASES.md). It is the whole contract: the module layout, the exported type, what a
case receives, every helper with its signature, the scenarios the stub can serve, and a worked
example. Nothing in this directory needs to be read to write a passing case.

## What is here

| File                                                                     | What it is                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `run.mts`                                                                | the runner: argument parsing, one Chrome, the per-case loop, the summary           |
| `case.mts`                                                               | `HarnessCase` and `CaseContext`: the contract a case implements                    |
| `case-registry.mts`                                                      | finds case modules by reading `cases/`                                             |
| `case-run.mts`                                                           | one case: its server, its tab, its timeout, and the checks every case is held to   |
| `harness.mts`                                                            | the one module a case imports                                                      |
| `browser.mts`                                                            | the Chrome process and the tabs opened in it                                       |
| `chrome.mts`                                                             | one tab: real mouse, keyboard, viewport, and evaluation                            |
| `cdp.mts`, `json.mts`, `browser-errors.mts`                              | the DevTools socket, JSON as a closed type, and the browser's own fault channels   |
| `server.mts`, `server-routes.mts`, `server-turn.mts`, `server-state.mts` | the stub: routes, the streaming turn with its barrier, and everything it remembers |
| `fixtures*.mts`, `turn-*.mts`                                            | the recorded worlds: projects, threads, generations, and turn frames               |
| `page-*.mts`, `selectors.mts`                                            | typed readers and actions over the rendered page                                   |
| `expect.mts`                                                             | the assertions, worded as sentences about the page                                 |
| `cases/`                                                                 | one surface per file group; `_`-prefixed files are that surface's own helpers      |

## What it proves, and what it cannot

The stub replaces the Supervisor, because a real turn would call a paid model API. Everything the
page can observe about its environment is kept identical: the same headers, the same Content
Security Policy with a per-response nonce, the same API shapes, and a turn that arrives as
newline-delimited frames over time. The stub never fakes page behaviour — every assertion reads
what the real page rendered.

A case is held to three checks it does not write: it must return evidence, the browser must have
reported no console error, uncaught exception, or policy violation, and no same-origin request may
have been refused unless the case declared that refusal.
