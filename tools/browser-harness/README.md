# Browser harness

`pnpm harness:browser` starts a local owner API stub, serves the real owner page, and drives headless Chrome through the DevTools Protocol. It checks that the page loads, has the declared root element, runs its inline script and fetches the owner API, and reports no console error, uncaught exception, or Content Security Policy violation.

It does not test Cloudflare Access. Access needs a deployed environment. The current command is a smoke check. It does not exercise streamed conversations, the project sidebar, the generation drawer, keyboard controls, or narrow and wide layouts.

## Run it

```sh
export CF_STUMBLE_CHROME="$(command -v chromium)"
pnpm harness:browser
```

`CF_STUMBLE_CHROME` names the Chrome, Chromium, or Edge executable to launch. Set it when browser discovery cannot find the right binary. The harness also searches the Playwright cache and common system paths.

## Stub API

`server.mts` starts the local stub. `server-routes.mts` defines the fixed owner API routes and page headers. `fixtures.mts` and `turn-fixture.mts` provide recorded API responses and streamed turn frames. The server serves the real page from `src/page`, with the same Content Security Policy as the Worker.

## Add a case

Add a scenario to `HARNESS_SCENARIOS` in `fixtures.mts`, then add its API payloads and turn frames. Write a check that uses `BrowserPage` to make real browser input and reads the result through `page-queries.mts`. Keep assertions on requests in the stub server when the check needs to prove what the page sent. Add the case to the command entrypoint when it should run in the browser check.
