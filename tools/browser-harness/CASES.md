# Writing a case

`pnpm harness:browser` runs every case in `tools/browser-harness/cases/`. This document is the
contract between the runner and a case. A case that follows it needs nothing from the driver.

## Where a case lives

One surface owns one or more files in `cases/`:

```
cases/chat-stream.mts     CHAT-1 … CHAT-4
cases/chat-endings.mts    CHAT-5 … CHAT-7
cases/chat-output.mts     CHAT-8 … CHAT-11
cases/chat-bounds.mts     CHAT-12 … CHAT-14
cases/_chat.mts           what those four files share
cases/smoke.mts           SMOKE-1, the fast plumbing check
```

The runner finds files by reading the directory. There is no registry to edit, so six surfaces can
be written at once without touching the same file. Two rules:

- A file in `cases/` must export `CASES: readonly HarnessCase[]`, or the run fails naming the file.
- A file whose name starts with `_` is skipped. That is where one surface keeps its own constants
  and helpers.

Keep a file under 300 lines and a `run` body under 50 lines; `pnpm lint` enforces both. Split by
theme, not by count.

## The one import

```ts
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { assertSame, readThread, sendPrompt, type HarnessCase } from "../harness.mjs";
```

`harness.mjs` re-exports every type, reader, action, assertion, wait, selector, and fixture
constant a case may use. If something is missing, add a reader — do not reach into the driver.

## The exported type

```ts
export type HarnessCase = Readonly<{
  id: string; // "CHAT-2"; the text before the dash names the surface
  title: string; // the case-list title, lower case
  rank: "must" | "should"; // from the case list; a failed must is reported as such
  scenario: HarnessScenario; // the world the stub serves this case
  viewport?: { width: number; height: number }; // default 1280 × 900
  start?: "settled" | "loaded" | "blank"; // default "settled"
  timeoutMs?: number; // default 60_000
  allowedRequestFailures?: readonly string[]; // "<METHOD> <path>" the stub may refuse
  run: (context: CaseContext) => Promise<string>; // returns the evidence line
}>;
```

`start` decides what the runner does before `run`:

- `settled` — set the viewport, navigate, and wait until the status, project, and thread reads have
  all answered. This is what almost every case wants.
- `loaded` — set the viewport and navigate; wait for the document only.
- `blank` — set the viewport and nothing else. The case navigates with
  `page.goto(`${server.url}/`)`.

## What a case receives

```ts
export type CaseContext = Readonly<{
  page: BrowserPage; // one tab, driven with real mouse and keyboard input
  server: HarnessServer; // the stub, in this process
  reopen: (scenario?: HarnessScenario) => Promise<void>;
}>;
```

`reopen` resets the stub's state — thread, generation ledger, project list, request log — switches
the scenario when one is named, reloads the page, and waits for the reads to settle. Use it when
one case must compare several worlds, as CHAT-5 does across five endings.

## What a case returns

A nonempty sentence naming what it observed. The runner prints it under the `PASS` line and fails
the case if it is empty. Write the numbers into it:

```
PASS CHAT-2 text and tools appear before the stream closes (1.8s)
     1 tool(s) and 143 assistant characters were visible at the barrier; 10 running samples never
     decreased and the turn finished with 3 tools
```

## What the runner already checks

Do not repeat these in a case:

- The case returned evidence.
- The browser reported no console error, uncaught exception, or Content Security Policy violation
  in this tab.
- No same-origin request was answered 4xx or 5xx, except the paths in `allowedRequestFailures`.

A case that expects a refusal declares it, method and path, exactly as the stub recorded it:

```ts
allowedRequestFailures: [`POST /api/projects/${HARNESS_PROJECT_ID}/turn`],
```

## Isolation and cost

Each case gets a fresh stub server and a fresh tab; one Chrome serves the whole run. A case
therefore costs about the time its own turns take — a chat case is one to two seconds — and leaves
nothing behind for the next one. Anything a case wants must be set up inside it.

## Rules

- Drive the page, never its script. `sendPrompt` types and clicks; a case that called the page's
  own function would prove nothing about the composer.
- Select by identifier or class from `src/page/element-ids.ts`, assert on what the element
  renders. A case that asserted "the element exists" has asserted nothing.
- Prove what left the browser with `server.requests()`, not with what the page displays about its
  own request.
- No narrating comments. The assertion message is where the meaning goes.
- Never change `src/`. A case that exposes a product defect is reported as a product defect.

## Assertions

From `harness.mjs`. Every one takes a `what` describing the reading, and prints both values:

| Assertion             | Signature                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `assert`              | `(held: boolean, message: string) => void`                                                               |
| `assertSame`          | `<T extends string \| number \| boolean>(actual: T, expected: T, what: string) => void`                  |
| `assertNonEmpty`      | `(value: string, what: string) => void`                                                                  |
| `assertIncludes`      | `(haystack: string, needle: string, what: string) => void`                                               |
| `assertExcludes`      | `(haystack: string, needle: string, what: string) => void`                                               |
| `assertAtLeast`       | `(value: number, minimum: number, what: string) => void`                                                 |
| `assertAtMost`        | `(value: number, maximum: number, what: string) => void`                                                 |
| `assertNonDecreasing` | `(values: readonly number[], what: string) => void`                                                      |
| `assertBefore`        | `(kinds: readonly string[], earlier: string, later: string) => void`                                     |
| `assertRequestBody`   | `(request: RecordedRequest \| undefined, expected: JsonRecord, what: string) => void`                    |
| `assertClickRefused`  | `(page: BrowserPage, selector: string, what: string, index?: number) => Promise<void>`                   |
| `selectRequests`      | `(requests: readonly RecordedRequest[], method: string, path: string) => readonly RecordedRequest[]`     |
| `selectRequestsLike`  | `(requests: readonly RecordedRequest[], method: string, fragment: string) => readonly RecordedRequest[]` |

## The page

`page: BrowserPage` makes real browser input. Nothing here simulates an event the browser would not
produce itself, so an element the layout collapsed or covered fails the click.

| Member          | Signature                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goto`          | `(url: string) => Promise<void>`                                                                                                                           |
| `reload`        | `() => Promise<void>`                                                                                                                                      |
| `click`         | `(selector: string, index?: number) => Promise<void>`                                                                                                      |
| `type`          | `(selector: string, text: string) => Promise<void>`                                                                                                        |
| `insertText`    | `(text: string) => Promise<void>` — into whatever holds focus                                                                                              |
| `press`         | `(key: "Tab" \| "Enter" \| "Escape" \| "Space" \| "ArrowDown" \| "ArrowUp", held?: readonly ("Shift" \| "Control" \| "Alt" \| "Meta")[]) => Promise<void>` |
| `setViewport`   | `(width: number, height: number) => Promise<void>`                                                                                                         |
| `box`           | `(selector: string) => Promise<ElementBox \| undefined>`                                                                                                   |
| `evaluate`      | `<T>(expression: string) => Promise<T>`                                                                                                                    |
| `waitFor`       | `(expression: string, timeoutMs?: number) => Promise<void>`                                                                                                |
| `consoleErrors` | `() => readonly string[]`                                                                                                                                  |
| `command`       | `(method: string, params?: Record<string, JsonValue>) => Promise<CdpResult>`                                                                               |

Shift-Tab is `press("Tab", ["Shift"])`. Control-Enter is `press("Enter", ["Control"])`.

## Actions

| Function        | Signature                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `sendPrompt`    | `(page, prompt: string) => Promise<void>` — type into the composer and click Send                       |
| `completeTurn`  | `(page, prompt: string, timeoutMs?: number) => Promise<void>` — send, then wait for an ending           |
| `openTool`      | `(page, index: number) => Promise<void>` — real click on the nth tool summary                           |
| `tabUntil`      | `(page, wanted: (stop: FocusSnapshot) => boolean, limit?: number) => Promise<readonly FocusSnapshot[]>` |
| `focusDocument` | `(page) => Promise<void>` — where a keyboard case starts                                                |

## Waits and samplers

| Function                   | Signature                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `waitForSettledReads`      | `(page, timeoutMs?) => Promise<void>`                                                                         |
| `waitForThreadOk`          | `(page, timeoutMs?) => Promise<void>`                                                                         |
| `waitForText`              | `(page, elementId: string, needle: string, timeoutMs?) => Promise<void>`                                      |
| `waitForTurnEnded`         | `(page, timeoutMs?) => Promise<void>`                                                                         |
| `waitForToolCount`         | `(page, count: number, timeoutMs?) => Promise<void>`                                                          |
| `waitForTranscriptText`    | `(page, needle: string, timeoutMs?) => Promise<void>`                                                         |
| `waitForTranscriptEntries` | `(page, count: number, timeoutMs?) => Promise<void>`                                                          |
| `sampleWhile`              | `<T>(read: () => Promise<T>, keep: (sample: T) => boolean, intervalMs?, timeoutMs?) => Promise<readonly T[]>` |
| `sleep`                    | `(ms: number) => Promise<void>`                                                                               |

`sampleWhile` returns every sample it took plus the one that ended it, which is what proves a
streamed count never went down.

## Readers

Each returns one snapshot taken in one round trip, so a snapshot cannot mix two moments of a
running turn.

| Reader                               | Answers                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readTurn(page)`                     | `turnState`, `assistantCharacters`, `assistantBlocks`, `tools`, `finishedTools`, `entries`, `sendDisabled`, `cancelDisabled`                                                       |
| `readThread(page)`                   | `project`, `state`, `revision`, `turnActive`, `messageCount`, `freshStatus`, `pageError`, `prompt`                                                                                 |
| `readGeneration(page)`               | the active bar (`activeLabel`, `activeCommit`, `activeStatus`, `epoch`, `lastRead`), `drawerOpen`, and every submit, activate, and rollback result and input                       |
| `readConversation(page)`             | `messages`, `roles`, `firstText`, `allText`, `tools`, `toolSummaries`, `openTools`, truncation-note counts, `createdImages`, `createdScripts`, `title`                             |
| `readTranscript(page)`               | `readonly { kind: string; text: string }[]` in render order; `kind` is `user`, `assistant`, `tool`, `diff`, `diff unavailable`, `terminal`, or `terminal problem`                  |
| `readTools(page)`                    | per disclosure: `summary`, `open`, `failed`, `output`, `outputLength`, `serverTruncated`, `displayShortened`                                                                       |
| `readDiffs(page)`                    | tool-patch counts and turn-diff counts separately, plus `diffText`, `unavailableMessages`, `unavailableText`                                                                       |
| `readProjectList(page)`              | `status`, `projects`, `labels`, `locations`, `selected`, `ariaCurrent`, GitHub state and detail, `connectStatus`, verification link `href`/`target`/`rel`/text, `credentialInputs` |
| `readLayout(page)`                   | `layoutClass`, sidebar and conversation boxes, viewport size, `toggleExpanded`, `toggleLabel`, `drawerOpen`; a collapsed element reads 0                                           |
| `readBox(page, selector)`            | `present`, `visible`, `width`, `height`, `top`, `right`, `bottom`, `left`                                                                                                          |
| `readPageMetrics(page)`              | `scrollWidth`, `clientWidth`, `horizontalOverflow`, `scrollHeight`, `clientHeight`, viewport size, `bodyWidth`, `bodyLeft`                                                         |
| `readScroll(page, elementId)`        | `scrollHeight`, `clientHeight`, `height`, `scrollable`, `overflowY`                                                                                                                |
| `readFocus(page)`                    | `id`, `tag`, `className`, `projectId`, `text`, `visible`, `outlineStyle`, `outlineWidth`, `boxShadow`                                                                              |
| `readAccessibleNode(page, selector)` | `role`, `name`, `ignored` from Chrome's own accessibility tree                                                                                                                     |
| `readFocusedAccessibleNode(page)`    | the same for whatever holds focus                                                                                                                                                  |
| `readText(page, elementId)`          | one element's text                                                                                                                                                                 |

## The stub

`server: HarnessServer` is the stub in this process, so a control is a function call and not an
HTTP request.

| Member                                     | Signature                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `url`                                      | `string`                                                                               |
| `scenario` / `setScenario`                 | `() => HarnessScenario` / `(scenario: HarnessScenario) => void`                        |
| `requests`                                 | `() => readonly RecordedRequest[]` — `{ method, path, body, status }` in arrival order |
| `clearRequests`                            | `() => void`                                                                           |
| `barrierReached` / `waitForBarrier`        | `() => boolean` / `(timeoutMs?) => Promise<void>`                                      |
| `release`                                  | `() => void` — let the held frames continue                                            |
| `responseClosed` / `waitForResponseClosed` | `() => boolean` / `(timeoutMs?) => Promise<void>`                                      |
| `thread`                                   | `(projectId: string) => { revision: number; messageCount: number }`                    |
| `projects`                                 | `() => readonly ProjectEntry[]`                                                        |
| `generation`                               | `() => { generations, activeLabel, epoch }`                                            |
| `setGeneration`                            | `(patch: { activeLabel?, epoch?, generations? }) => void` — out-of-band change         |
| `reset`                                    | `(scenario?: HarnessScenario) => void`                                                 |

The stub serves the real page from `src/page` behind the Worker's own Content Security Policy, and
answers the real API shapes. It never fakes page behaviour.

### Scenarios

A scenario is what cannot be reached by driving the page. Everything else — the thread, the
generation ledger, the connected repositories — is state the stub keeps and a case changes by
acting on the page or by calling a control.

| Scenario                        | The turn it streams, and what else differs                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                         | text, `read_file`, text, `apply_patch`, `run_command` (large, server-truncated), text, the turn's own diff, `saved · revision 4 · 6 messages` |
| `ready-paused`                  | the same turn, held after the first text and one completed tool                                                                               |
| `no-terminal-frame`             | text and three tools, then the body ends with no terminal frame                                                                               |
| `no-diff`                       | text, one successful read, `saved`; neither diff frame                                                                                        |
| `diff-unavailable`              | the ready turn with the reason in place of the diff                                                                                           |
| `markup-output`                 | a script-shaped text frame and an `<img … onerror=` tool result                                                                               |
| `long-line`                     | one successful 200,000-character line marked `LONG-START` … `LONG-END`, `truncated: false`                                                    |
| `tool-failed`                   | one failed tool inside a turn that still saves                                                                                                |
| `project-switch`                | held after one tool; every later frame carries `EXTERNAL-LATE`                                                                                |
| `turn-failed`                   | `failed: model-error · saved at revision 4`                                                                                                   |
| `save-failed`                   | `not saved: stale-revision`; the stored thread stays at revision 3                                                                            |
| `stream-invalid`                | `unreadable turn stream: malformed-frame`                                                                                                     |
| `cancelled`                     | the Supervisor's own `cancelled` terminal frame                                                                                               |
| `timed-out`                     | `timed out`                                                                                                                                   |
| `turn-conflict`                 | HTTP 409 `turn-conflict` before any frame                                                                                                     |
| `no-active-generation`          | HTTP 503 `no-active-generation` before any frame                                                                                              |
| `no-projects`                   | `GET /api/projects` answers an empty catalog with connected GitHub                                                                            |
| `github-disconnected`           | GitHub state `disconnected`                                                                                                                   |
| `github-awaiting-authorization` | state `awaiting-authorization`, code `WDJB-MJHT`, GitHub's device link                                                                        |
| `status-problem`                | `GET /api/status` is refused, so the page renders no epoch                                                                                    |

### Baseline data

- Projects: `octocat-hello-world` shown as `hello-world` at
  `https://github.com/octocat/hello-world`, and the harness entry shown as `harness` at
  `/workspace/harness`. Connecting adds `octocat-new-repo` at
  `https://github.com/octocat/new-repo` without changing the selection.
- Threads: every project starts at revision 3 with two messages. The first names the project id and
  its location; the second carries `HARNESS-THREAD` for the harness entry and `EARLIER-EDIT-KEPT`
  for a repository. A saved frame moves that project's thread to revision 4 with six messages; a
  fresh thread moves it to the next revision with none.
- Generations: generation 1, commit `abc123`, status `ready`, epoch 3. Submitting `def456` labels
  ready generation 2 and does not activate it. Submitting `broken456` labels generation 2 and
  answers `rejected: startup-check-failed`. Submitting a commit that already has a label returns
  that label. Activation and rollback refuse an `observedEpoch` that is not the stub's own with
  `rejected: stale-epoch`, answer `no-change` for the already-active label, and otherwise advance
  the epoch by one.

## Worked example

`CHAT-2` in full. It proves the page renders a turn before the response body ends, which is the
only claim that cannot be made from a finished transcript.

```ts
import {
  assertAtLeast,
  assertIncludes,
  assertNonDecreasing,
  assertSame,
  FRAME_INTERVAL_MS,
  readConversation,
  readTranscript,
  readTurn,
  sampleWhile,
  sendPrompt,
  sleep,
  waitForTurnEnded,
  type HarnessCase,
} from "../harness.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "CHAT-2",
    title: "text and tools appear before the stream closes",
    rank: "must",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await sendPrompt(page, "Add the project sidebar");
      await server.waitForBarrier();
      await sleep(FRAME_INTERVAL_MS);

      const held = await readTurn(page);
      const heldTranscript = await readConversation(page);
      assertSame(held.turnState, "running", "the turn state at the barrier");
      assertSame(held.sendDisabled, true, "Send while the turn runs");
      assertSame(held.cancelDisabled, false, "Cancel while the turn runs");
      assertAtLeast(held.assistantCharacters, 1, "assistant characters at the barrier");
      assertAtLeast(held.finishedTools, 1, "finished tools at the barrier");
      assertIncludes(heldTranscript.allText, "Add the project sidebar", "the transcript");

      server.release();
      const samples = await sampleWhile(
        () => readTurn(page),
        (sample) => sample.turnState === "running",
        100,
      );
      const running = samples.filter((sample) => sample.turnState === "running");
      assertAtLeast(running.length, 3, "samples taken while the turn was running");
      assertNonDecreasing(
        running.map((sample) => sample.assistantCharacters),
        "streamed assistant characters",
      );

      await waitForTurnEnded(page);
      const kinds = (await readTranscript(page)).map((entry) => entry.kind);
      assertSame((await readTurn(page)).tools, 3, "tool blocks when the turn ended");
      assertAtLeast(
        kinds.slice(0, kinds.indexOf("terminal")).filter((kind) => kind === "assistant").length,
        2,
        "assistant blocks rendered before success",
      );

      return `${held.tools} tool(s) were visible at the barrier and ${running.length} running samples never decreased`;
    },
  },
];
```

## Running

```sh
export CF_STUMBLE_CHROME="$(command -v chromium)"
pnpm harness:browser                 # every case
pnpm harness:browser --only chat     # one surface
pnpm harness:browser --only CHAT-2   # one case
pnpm harness:browser --only smoke    # the plumbing check
pnpm harness:browser --list          # what is registered
```

The run exits non-zero when any case fails, and names every failure in its summary.
