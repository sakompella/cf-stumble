# Owner page end-to-end web test cases (opus author)

These are 39 cases a CDP-driving agent can execute against the real owner page. They were written
from `src/page/`, `src/routes/page.ts`, the turn frame vocabulary in
`src/supervisor/projects/turn-frames.ts`, the generation control results in
`src/supervisor/control/`, and the existing harness in `tools/browser-harness/`.

## How to run a case

Every case runs inside the existing harness plumbing:

1. `const server = await startHarnessServer(<scenario>)` from `tools/browser-harness/server.mjs`.
   It serves the real page from `src/page/` behind the same headers and the same Content Security
   Policy the Worker sends, and it streams the turn as newline-delimited frames with a 120 ms gap
   between them.
2. `const page = await BrowserPage.launch()` from `tools/browser-harness/chrome.mjs`, then
   `page.setViewport(w, h)` and `page.goto(`${server.url}/`)`.
3. Read state with the typed snapshot readers in `tools/browser-harness/page-queries.mjs`
   (`readConversation`, `readTurn`, `readDiffs`, `readProjectList`, `readThread`, `readLayout`,
   `readFocus`, `readText`).
4. Read what the browser actually sent with `server.requests()` or
   `GET {server.url}/__harness/requests`. What the page displays is never evidence that the page
   sent the right thing.
5. Switch worlds mid-run with `server.setScenario(name)` or
   `POST {server.url}/__harness/scenario?name=<name>`.

## Rules every case inherits

- **Preconditions, unless a case overrides them:** scenario `ready`; viewport 1280x900; the page
  loaded and `document.readyState === "complete"`; the first project auto-selected (the page
  selects `projects[0]` on load).
- **Every case also asserts** `page.consoleErrors()` is empty at the end. That collector reports
  console errors, uncaught exceptions, and Content Security Policy violations, so a page whose
  script died halfway cannot pass a DOM assertion.
- **Every case asserts something non-empty.** No case may pass against a page that rendered
  nothing: each one names a concrete text, count, or measured box.
- **Identifiers.** Cases name elements through `OWNER_PAGE_IDS` and `OWNER_PAGE_CLASSES` imported
  from `src/page/element-ids.ts`. That map is the page's own declared contract, and it is the same
  map the markup and the inline script are built from, so a rename breaks the check at compile
  time instead of turning it into a silent pass. No case reads a script variable, a private
  function, or a CSS rule.
- **Nothing about deleted machinery.** `main` no longer has a recovery report panel, a turn-credit
  field, or an eligibility surface. No case below mentions them, and a case that starts asserting
  them is wrong.
- **Wording is a contract here.** The page's status lines are what the owner reads to decide
  whether a turn was saved, so cases assert the exact text the page produces (for example
  `saved · revision 4 · 6 messages`). Assert on a substring only where a case says so.

## Current harness coverage

`pnpm harness:browser` runs `tools/browser-harness/run.mts`, **which does not exist in the tree**;
the script fails immediately. The only working driver today is `tools/browser-harness/smoke.mts`
(`pnpm exec tsx tools/browser-harness/smoke.mts`), and it asserts four facts: the document title,
the presence of the root element, that the inline script issued at least one `/api/` fetch, and
that the browser reported no fault. `tools/browser-harness/page-queries.mts` is complete but no
driver calls it. `tools/browser-harness/README.md`, which `AGENTS.md` tells agents to read, is also
missing.

So: **no case below is executed today.** What differs between cases is how much new code each one
needs.

| Need                                  | Cases                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Driver only; fixtures already suffice | CHAT-2, CHAT-3, CHAT-4, CHAT-6, CHAT-7, CHAT-8, CHAT-9, CHAT-13, CHAT-14, GEN-1, GEN-2, GEN-3, GEN-5, GEN-7, GEN-8, SIDE-2, SIDE-5, SIDE-6, KEY-1 to KEY-5, NAR-1 to NAR-3, WID-1 to WID-3 |
| Driver plus a new server scenario     | CHAT-5, CHAT-10, CHAT-11, CHAT-12, GEN-4, GEN-6, SIDE-4                                     |
| Driver plus a changed project fixture | CHAT-1, SIDE-1, SIDE-3, SIDE-2, and any case that counts sidebar entries                     |

New fixture work these cases assume, all inside `tools/browser-harness/`:

1. `projectsPayload` currently returns two GitHub repositories (`hello-world`, `spoon-knife`).
   Decision 3 cut the second repository. Replace it with **one connected repository plus the
   harness entry** — an entry whose `displayName` is the harness and whose second line names
   `/workspace/harness` rather than a GitHub URL. Note that `GET /api/projects` on `main` does not
   yet produce a harness entry at all; SIDE-1 and SIDE-3 fail until the product adds it, and that
   failure is the point.
2. Scenario `no-projects`: `{ ok: true, projects: [], github: <connected> }` (SIDE-4).
3. Scenario `stale-epoch`: `POST /api/generations/activate` and `/rollback` answer
   `{ ok: false, problem: { code: "stale-epoch" } }` with HTTP 200, and `GET /api/status` then
   reports a higher epoch than the one the page had rendered (GEN-6).
4. Scenario `preparation-failed`: `POST /api/generations/submit` answers `ok: true` with
   `preparation.report.stage: "response-rejected"` and a reason, while `GET /api/status` keeps
   reporting the same active label, commit, and epoch as before (GEN-4).
5. Scenario `no-terminal-frame`: stream the turn frames up to the last text frame, then `res.end()`
   without any terminal frame (CHAT-5).
6. Scenario `no-diff`: the normal frame list with the `diff` frame removed and `saved` last
   (CHAT-10).
7. Scenario `markup-output`: one tool result whose content is
   `<img src=x onerror="document.title='pwned'">` and one text frame containing
   `<script>document.title='pwned'</script>` (CHAT-11).
8. Scenario `single-line-output`: one tool result whose content is a single line of about 200,000
   characters with no newline, `truncated: false` (CHAT-12).
9. Scenario `tool-failed`: one tool result with `isError: true` and a short error body (CHAT-13).
10. A status route that answers with a problem payload instead of an active generation, so GEN-8
    step 3 can reach the `refresh the status first` guard. A route that destroys the socket without
    answering would also let the error banner be tested; see the gaps list at the end.

---

## 1. Chat stream

### CHAT-1 — the saved conversation appears for the selected project (must)

**Intent.** A reader who opens the page sees the conversation the Supervisor stored, not an empty
list.

**Preconditions.** Scenario `ready` with the one-repository-plus-harness project fixture.

**Steps.**

1. Load the page.
2. Wait until `readThread(page).state === "ok"`.
3. Take `readThread(page)` and `readConversation(page)`.

**Assertion.** `thread.project` equals the connected repository's display name.
`thread.revision === "3"`, `thread.turnActive === "no"`, `thread.messageCount === "2"`.
`conversation.messages === 2`, `conversation.roles` are `message user` then `message assistant`,
and `conversation.allText` contains the connected project's id (the fixture writes the project id
into the first saved message).

**Failure.** Zero messages, a message count of `0`, `state` holding a `rejected:` or `error:`
string, or a transcript whose text names a different project — the page either did not read the
thread or rendered another project's conversation.

### CHAT-2 — the transcript grows while the turn is still running (must)

**Intent.** Catch a page that stopped streaming and only paints when the response body ends.

**Steps.**

1. Load the page, type `add a sidebar` into the prompt, click **Send turn**.
2. Poll `readTurn(page)` every 100 ms. Record the first sample where `assistantCharacters > 0`, and
   every sample after it, until `turnState` leaves `running`.
3. Also record, at the moment `turnState` is still `running`, whether `sendDisabled` is true and
   `cancelDisabled` is false.

**Assertion.** At least three distinct samples were taken while `turnState === "running"`.
`assistantCharacters` was greater than zero and `tools` was at least one **before** `turnState`
changed. Both counters are non-decreasing across samples, and the final `tools` count is 3.
While running, Send is disabled and Cancel is enabled.

**Failure.** Every intermediate sample shows `assistantCharacters === 0` and `tools === 0`, and the
transcript appears only after the terminal frame; or the counters never reach 3 tools; or Send
stayed enabled during the turn.

### CHAT-3 — the terminal frame is the only success, and the page re-reads the thread (must)

**Intent.** The page must report what the Supervisor said it saved, and then check its own work
against the stored thread.

**Steps.**

1. Send a turn as in CHAT-2 and wait until `readTurn(page).turnState !== "running"`.
2. Read `readThread(page)` and `server.requests()`.

**Assertion.** `turnState` is exactly `saved · revision 4 · 6 messages`. The transcript's last
entry has class `message terminal` and the same wording. `thread.revision === "4"` and
`thread.messageCount === "6"`. In `server.requests()`, a `GET /api/projects/<id>/thread` appears
**after** the `POST /api/projects/<id>/turn`. The streamed transcript is still present after that
re-read: `readConversation(page).tools === 3`.

**Failure.** A success wording taken from the HTTP status rather than the frame; a thread still at
revision 3, which means the page never re-read it; or a transcript wiped by the re-read.

### CHAT-4 — every non-saved ending says what happened (must)

**Intent.** Four different endings must produce four different, specific statements, and none of
them may look like success.

**Steps.** For each scenario in the table: start a fresh page on that scenario, send a turn, wait
for `turnState` to settle, then read `readTurn` and `readConversation`.

| Scenario         | Expected `turnState`                       |
| ---------------- | ------------------------------------------ |
| `turn-failed`    | `failed: model-error · saved at revision 4` |
| `save-failed`    | `not saved: stale-revision`                 |
| `stream-invalid` | `unreadable turn stream: malformed-frame`   |
| `timed-out`      | `timed out`                                 |

**Assertion.** `turnState` matches the row exactly. The last transcript entry has class
`message terminal problem` and carries the same text. No entry has class `message terminal`
without `problem`. For `save-failed`, `readThread(page).revision` is still `3`.

**Failure.** Any row showing `saved`, an empty `turnState`, the same wording for two different
scenarios, or a `terminal` class without `problem`.

### CHAT-5 — a stream that ends without a terminal frame is reported (must)

**Intent.** This is the case that fails when the page silently stops streaming: the server hangs up
mid-turn and the page must say so rather than leaving `running` forever or claiming success.

**Preconditions.** Scenario `no-terminal-frame` (new).

**Steps.**

1. Send a turn.
2. Wait up to 20 s for `readTurn(page).turnState !== "running"`.
3. Read `readTurn`, `readConversation`, `readThread`.

**Assertion.** `turnState` is exactly `the turn stream ended without a terminal frame`. The
transcript still holds the frames that did arrive (`tools === 3`, `assistantCharacters > 0`), so
the page kept what it received. Send is enabled again and Cancel is disabled.
`readThread(page).turnActive === "no"`.

**Failure.** `turnState` stuck at `running` past the timeout, a `saved` wording with no terminal
frame behind it, Send left disabled forever, or a transcript cleared by the failure.

### CHAT-6 — cancelling stops the turn and nothing is saved (must)

**Intent.** The owner's cancel must abort the request, restore the composer, and not invent a save.

**Steps.**

1. Send a turn.
2. Wait until `readTurn(page).tools >= 1`, then click **Cancel turn**.
3. Wait until `turnState !== "running"` and `!== "cancelling"`.
4. Read `readTurn`, `readThread`, and `server.requests()`.

**Assertion.** `turnState` is exactly `cancelled: this browser stopped the turn`.
`sendDisabled === false`, `cancelDisabled === true`. `readThread(page).revision` is still `3` and
`messageCount` is still `2`, because the harness only advances the thread when it writes the
`saved` frame. The partial transcript is still visible (`tools >= 1`).
`readThread(page).pageError` is empty: a cancel the owner asked for is not a page error.

**Failure.** A `saved` wording, a revision that moved to 4, Cancel still enabled, an error banner,
or `turnState` left at `cancelling`.

### CHAT-7 — a refusal before any frame is explained in the owner's terms (must)

**Intent.** The two refusals a turn can receive over HTTP must be translated, not shown as a code.

**Steps.** For each row: fresh page on that scenario, send a turn, read `readTurn` and
`readConversation`.

| Scenario              | HTTP | Expected `turnState`                                                |
| --------------------- | ---- | ------------------------------------------------------------------- |
| `turn-conflict`       | 409  | `busy: another turn holds this project`                             |
| `no-active-generation`| 503  | `no active generation: activate one in the generation controls`     |

**Assertion.** `turnState` matches exactly. The transcript holds the prompt the owner typed
(`allText` contains it) and **no** tool block or terminal entry: `tools === 0`, and no entry has a
class containing `terminal`. Send is enabled again.

**Failure.** A raw `rejected: turn-conflict` or `error: HTTP 503`, an empty state, or a terminal
entry the server never sent.

### CHAT-8 — the turn's own diff is rendered, and it is not the tool's diff (must)

**Intent.** Demo step 3 ends in a readable diff. The turn's diff and a tool's patch output arrive
by different routes, so the page must render both and not double one of them.

**Steps.** Send a turn on `ready`, wait for `saved`, then `readDiffs(page)`.

**Assertion.** `diffMessages === 1`. `diffAdded === 3`, `diffRemoved === 2`, `diffHunks === 3`.
`diffText` contains `src/routes/turns.ts` and `parseProjectId`, and does **not** contain
`markup.ts`. Separately, the tool result's patch is marked too: `toolAdded === 3`,
`toolRemoved === 1`, `toolHunks === 3`.

**Failure.** `diffMessages === 0` (the turn's diff never rendered); `diffMessages === 2` (rendered
twice); added and removed counts equal to the tool result's, which means the same content was
rendered in both places; or every diff line unclassified, which means the page showed a wall of
text instead of a marked diff.

### CHAT-9 — a turn that cannot produce a diff says why (must)

**Intent.** The reason must replace the diff, so a reader is never left guessing whether the turn
changed nothing or the repository could not answer.

**Preconditions.** Scenario `diff-unavailable`.

**Steps.** Send a turn, wait for the terminal state, read `readDiffs` and `readTurn`.

**Assertion.** `unavailableMessages === 1` and `unavailableText` contains
`the workspace held no git repository`. `diffMessages === 0`, `diffAdded === 0`,
`diffRemoved === 0`. `turnState` is `saved · revision 4 · 6 messages`, because a missing diff is
not a failed turn.

**Failure.** No unavailable entry at all, an empty unavailable entry, a diff message rendered
anyway, or the turn reported as failed.

### CHAT-10 — a turn that ends with no diff frame at all still ends cleanly (must)

**Intent.** The `diff` and `diff-unavailable` frames are both optional. A turn that sends neither
must still reach a stated ending, with no placeholder diff invented.

**Preconditions.** Scenario `no-diff` (new).

**Steps.** Send a turn, wait for the terminal state, read `readDiffs`, `readTurn`,
`readConversation`.

**Assertion.** `diffMessages === 0` and `unavailableMessages === 0`. `turnState` is
`saved · revision 4 · 6 messages`. The transcript still holds the three tool blocks and the
assistant text, and its last entry is the `message terminal` one.

**Failure.** An empty diff block, a `diff` entry with no content, a stuck `running` state, or a
transcript missing its tool blocks.

### CHAT-11 — repository and model output stay text (must)

**Intent.** Everything in a turn comes from a repository, a command, or a model. None of it may
become markup this page runs.

**Preconditions.** Scenario `markup-output` (new).

**Steps.**

1. Record `document.title` before the turn.
2. Send a turn and wait for the terminal state.
3. Evaluate, inside the message list only:
   `document.querySelectorAll("#conversation-messages img, #conversation-messages script").length`.
4. Read `readConversation(page)` and `document.title`.

**Assertion.** The query returns `0`. `document.title` is still `cf-stumble`.
`conversation.allText` contains the literal strings `<img src=x onerror=` and
`<script>document.title=`. `page.consoleErrors()` is empty, which also means no Content Security
Policy violation was logged.

**Failure.** A non-zero element count, a changed title, or output that appears rendered rather than
quoted — any of these means the page assigned HTML somewhere.

### CHAT-12 — one very long line is bounded and does not break the layout (must)

**Intent.** A single-line command output (a minified bundle, a one-line log) must be cut for
display, and it must not push the page sideways or bury the composer.

**Preconditions.** Scenario `single-line-output` (new); viewport 1280x900.

**Steps.**

1. Send a turn and wait for the terminal state.
2. Open the tool block: click its `summary`.
3. Read `readConversation(page)`.
4. Evaluate the rendered length:
   `document.querySelector("pre.tool-output").textContent.length`.
5. Evaluate horizontal overflow:
   `document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth`.
6. Click **Send turn** again with an empty prompt (a real mouse click at the button's centre).

**Assertion.** `displayShortenedNotes === 1` and the note text contains `shortened for display`.
The rendered length is at most about 20,100 characters, far below the 200,000 the server sent.
The horizontal overflow value is at most 1 px. The final click succeeded, which proves the button
still has a visible box a mouse can reach, and `readTurn(page).turnState` is
`type a prompt first`.

**Failure.** The full 200,000 characters in the DOM; no shortening note; a document wider than its
viewport; or a click on Send that throws because the layout covered or collapsed the button.

### CHAT-13 — tool blocks stay collapsed, and a failed one opens itself (should)

**Intent.** A long turn must stay readable: results are collapsed until the reader opens one, but a
failure is not something the reader has to go looking for.

**Preconditions.** Two runs — one on `ready`, one on `tool-failed` (new).

**Steps.**

1. On `ready`: send a turn, wait for the terminal state, read `readConversation`. Then click the
   third tool block's `summary` and read again.
2. On `tool-failed`: send a turn, wait for the terminal state, read `readConversation` and read the
   failed block's class.

**Assertion.** On `ready`: `tools === 3` and `openTools === 0` before the click, `openTools === 1`
after it; `toolSummaries` end with `— done`; `serverTruncatedNotes === 1` and
`displayShortenedNotes === 1` for the large `run_command` result. On `tool-failed`: the failing
block has `open === true`, its class contains `failed`, and its summary ends with `— failed`.

**Failure.** Every block open on arrival, which means a hundred-line output is laid out eagerly; a
failed block left collapsed; or a summary that never changes from `running…`.

### CHAT-14 — a fresh thread needs two clicks and never runs during a turn (must)

**Intent.** Losing a conversation to one mis-click is the destructive mistake this page must
prevent, and the reset must not race a running turn.

**Steps.**

1. Send a turn. While `turnState === "running"`, click **Start fresh thread** and read
   `readThread(page).freshStatus`.
2. Wait for the terminal state.
3. Click **Start fresh thread** once; read `freshStatus` and `readConversation`.
4. Click it a second time; wait until `freshStatus` changes; read `readThread`,
   `readConversation`, and `server.requests()`.

**Assertion.** Step 1: `freshStatus` is `a turn is running; cancel it first`, and no
`POST .../thread/fresh` appears in `server.requests()` at that point. Step 3: `freshStatus`
contains `click again to replace this conversation`, and the transcript is unchanged
(`messages` count identical to before the click). Step 4: `freshStatus` is
`fresh thread started; repository files are untouched`; `readThread(page).revision === "5"` and
`messageCount === "0"`; `readConversation(page).messages === 0`; exactly one
`POST /api/projects/<id>/thread/fresh` was recorded.

**Failure.** The conversation cleared on the first click; a reset accepted while a turn ran; more
than one fresh-thread request; or the revision unchanged after the reset.

---

## 2. Generation drawer

### GEN-1 — the active generation is on screen when the page opens (must)

**Intent.** Demo step 1: open the page and see the active generation.

**Steps.** Load the page, wait until `readText(page, ID.statusStatus) === "ok"`, then read the four
values.

**Assertion.** `activeGenerationLabel === "1"`, `activeGenerationCommit === "abc123"`,
`activeGenerationStatus === "ready"`, `generationEpoch === "3"`, `statusStatus === "ok"`. A
`GET /api/status` appears in `server.requests()`.

**Failure.** Any of the four empty, `none`, `reading`, or a `rejected:` / `error: HTTP` string in
`statusStatus`.

### GEN-2 — the controls are one click away and closed until asked for (must)

**Intent.** The drawer must not take attention from the turn, and it must still be reachable.

**Steps.**

1. Load the page and read `readLayout(page).drawerOpen`.
2. Evaluate whether the submit button has a visible box:
   `document.getElementById("submit-candidate-button").getBoundingClientRect().height > 0`.
3. Click the drawer's `summary`, then read both again.

**Assertion.** Before the click, `drawerOpen === false` and the submit button has no visible box.
After the click, `drawerOpen === true`, the submit button has a visible box, and `page.click` on
it succeeds. The generation label and epoch from GEN-1 are readable in both states.

**Failure.** The drawer open on load; controls that stay unreachable after the click; or the active
label and epoch hidden inside the drawer, which would put demo step 1 behind an interaction.

### GEN-3 — submitting a candidate reports what was labeled and checked (must)

**Intent.** Demo step 4: submit a harness commit and read the build and cold-start result.

**Steps.**

1. Open the drawer, type `def456` into the harness commit field, click **Submit candidate**.
2. Wait until `readText(page, ID.submitStatus) !== "running"`.
3. Read the four submit values and `server.requests()`.

**Assertion.** `submitStatus === "ok"`, `submitGenerationLabel === "2"`, `submitEpoch === "3"`,
`submitPreparation === "ready: startup check answered"`. `server.requests()` holds exactly one
`POST /api/generations/submit` whose body is `{ "harnessCommit": "def456" }` — the value the owner
typed and no other field. A `GET /api/status` follows the submission, so the drawer is re-read
against the server rather than from what the page assumed.

**Failure.** A blank preparation line, a status still `running` after the timeout, a body carrying
an epoch or a label the page invented, or no status refresh after the submission.

### GEN-4 — a failing candidate does not disturb the generation that serves (must)

**Intent.** Demo step 6, and the evidence the owner wants captured: a broken candidate fails its
startup check while the active generation keeps serving.

**Preconditions.** Scenario `preparation-failed` (new). `GET /api/status` keeps answering label 1,
commit `abc123`, epoch 3.

**Steps.**

1. Note the active label, commit, epoch and status from GEN-1.
2. Open the drawer, submit commit `bad999`, wait for `submitStatus` to settle.
3. Read the submit values and the four active-generation values again.
4. Close the drawer, type a prompt, send a turn, and wait for its terminal state.

**Assertion.** `submitStatus === "ok"` (a recorded failure is not a transport failure) and
`submitPreparation` starts with `response-rejected:` and carries a non-empty reason. The active
label is still `1`, the active commit still `abc123`, the status still `ready`, and the epoch still
`3`. The turn in step 4 reaches `saved · revision 4 · 6 messages`, so the page and the serving
generation both kept working.

**Failure.** The active label, commit, or epoch changing after a failed candidate; an empty or
`ok`-looking preparation line for a check that failed; an error banner; or a turn that can no
longer run.

### GEN-5 — activation sends the epoch the reader can see (must)

**Intent.** ADR-0033: the value the page displays is the value the request carries. Otherwise a
concurrent change could be overwritten silently.

**Steps.**

1. Load the page, read `generationEpoch` (`"3"`).
2. Open the drawer, type `2` into the activate label field, click **Activate**.
3. Wait until `activateStatus !== "running"`.
4. Read `activateStatus`, `activateEffect`, `activateSentEpoch`, `generationEpoch`, and
   `server.requests()`.

**Assertion.** The recorded `POST /api/generations/activate` body is exactly
`{ "observedEpoch": 3, "label": 2 }` — `observedEpoch` equals the epoch the page displayed before
the click, taken from the request record rather than from the page's own claim. `activateStatus`
is `ok`, `activateEffect` is `activated`, `activateSentEpoch` is `3`. After the automatic status
refresh, `generationEpoch` is `4`.

**Failure.** A body whose `observedEpoch` differs from the displayed epoch, or which carries extra
fields; an empty effect; or a displayed epoch that never moves, which means the page did not
re-read status after acting.

### GEN-6 — a stale epoch is rejected and the page says so (must)

**Intent.** The rejection the epoch exists for must be visible, and the page must not report a
partial success.

**Preconditions.** Scenario `stale-epoch` (new).

**Steps.**

1. Load the page (epoch renders as `3`), open the drawer, type `2`, click **Activate**.
2. Wait until `activateStatus !== "running"`; read `activateStatus`, `activateEffect`,
   `activateSentEpoch`.
3. Click **Refresh status**, wait for `statusStatus === "ok"`, read `generationEpoch`.
4. Read the four active-generation values.

**Assertion.** `activateStatus === "rejected: stale-epoch"`. `activateEffect` is empty — the page
clears the effect on a rejection rather than leaving the previous one to be misread.
`activateSentEpoch === "3"`, which is the epoch that was sent. After the refresh, `generationEpoch`
is the server's newer value (`4` in the fixture) and `statusStatus === "ok"`. The active label and
commit are whatever `GET /api/status` reports, not what the rejected request asked for.

**Failure.** `ok` or an empty status; a stale effect left on screen; the page's epoch never
catching up after the refresh; or an unhandled exception in `consoleErrors()`.

### GEN-7 — rollback is its own control and loads the earlier generation (must)

**Intent.** Demo step 7: roll back and keep everything else. Rollback must not be a second name for
activation.

**Steps.**

1. Load the page, note the transcript state after the initial thread read.
2. Open the drawer, type `1` into the rollback label field, click **Roll back**.
3. Wait until `rollbackStatus !== "running"`.
4. Read the rollback values, the active-generation values, `readConversation`, and
   `server.requests()`.

**Assertion.** The recorded request is `POST /api/generations/rollback` with body
`{ "observedEpoch": 3, "label": 1 }`; no `POST /api/generations/activate` was sent.
`rollbackStatus === "ok"`, `rollbackEffect === "rolled-back"`, `rollbackSentEpoch === "3"`. After
the refresh, `activeGenerationCommit === "abc123"` and `generationEpoch === "4"`. The activate
panel's status and effect are still empty, and the conversation still holds its two saved messages
— rollback did not clear the transcript.

**Failure.** A rollback that posts to the activate path; the activate panel showing the rollback's
result; an empty effect; or a transcript lost across the rollback.

### GEN-8 — a control with missing input sends nothing (should)

**Intent.** The page must refuse its own incomplete requests locally, so the Supervisor never
receives a guess.

**Steps.**

1. Open the drawer. Click **Submit candidate** with the commit field empty; read `submitStatus`.
2. Click **Activate** with the label field empty; read `activateStatus`.
3. In a second run, before any status read succeeds, blank the epoch by loading the page against a
   status route that returns a problem, then click **Activate** with label `2`; read
   `activateStatus`.
4. Read `server.requests()` after each.

**Assertion.** Step 1: `submitStatus === "enter a harness commit first"`. Step 2:
`activateStatus === "enter a generation label"`. Step 3:
`activateStatus === "refresh the status first"`. In every step, `server.requests()` contains no
`POST /api/generations/...` entry at all.

**Failure.** Any POST leaving the browser; a silent no-op with no wording; or a request whose body
holds `NaN`, `null`, or an empty string.

---

## 3. Project sidebar

### SIDE-1 — the sidebar lists the connected repository and the harness (must)

**Intent.** Demo step 2's choice: exactly one connected GitHub repository, plus the harness as a
project.

**Preconditions.** The one-repository-plus-harness fixture.

**Steps.** Load the page, wait until `readProjectList(page).projects.length > 0`, read the
snapshot.

**Assertion.** `projects.length === 2`. One entry is the connected GitHub repository and its label
carries its repository URL. The other is the harness entry, and its label names `/workspace/harness`
rather than a GitHub URL. `status === "2 connected"`. `githubState === "connected"` and
`githubDetail === "octocat (owner-authorization)"`.

**Failure.** A third entry (a second GitHub repository was reintroduced); a missing harness entry
(the product still does not offer it); a label with no repository or path line, which leaves the
reader unable to tell the two entries apart; or `status` left at `reading`.

### SIDE-2 — one project is selected, and the selection is stated for assistive technology (must)

**Steps.** Load the page, wait for the list, read `readProjectList` and `readThread`.

**Assertion.** `selected.length === 1` and it is `projects[0]`. `ariaCurrent` is `["true", "false"]`
in list order — exactly one `true`. `thread.project` equals the selected entry's display name.

**Failure.** Zero or two selected entries; every `aria-current` false; or a heading still saying
`No project selected` while a button looks selected.

### SIDE-3 — selecting the harness entry switches the conversation (must)

**Intent.** Selecting the second entry must load that entry's own thread and drop the first one's
transcript.

**Steps.**

1. Load the page, wait for the first project's thread, record `readConversation(page).allText`.
2. Click the harness entry's button.
3. Wait until `readThread(page).state === "ok"` and the heading changes.
4. Read `readProjectList`, `readThread`, `readConversation`, `server.requests()`.

**Assertion.** `selected` is now the harness entry only, and `ariaCurrent` moved with it.
`thread.project` is the harness entry's display name. `conversation.allText` contains the harness
entry's project id and no longer contains the first project's id. A
`GET /api/projects/<harness-id>/thread` was recorded after the click.

**Failure.** The heading changing but the transcript staying (the page kept the old conversation);
both entries marked current; no thread request for the new selection; or an empty transcript with
no state wording.

### SIDE-4 — an empty project list says so, and the composer refuses politely (must)

**Intent.** A fresh account has nothing connected. The page must explain that instead of looking
broken.

**Preconditions.** Scenario `no-projects` (new).

**Steps.**

1. Load the page, wait until `readProjectList(page).status !== "reading"`.
2. Read `readProjectList`, `readThread`.
3. Type `hello` into the prompt, click **Send turn**, read `readTurn` and `server.requests()`.
4. Click **Start fresh thread**, read `readThread(page).freshStatus`.

**Assertion.** `projects.length === 0` and `status === "no repository connected yet"`.
`thread.project === "No project selected"`, `thread.state === "select a project first"`, and
`thread.pageError` is empty — an empty catalog is not an error. `readTurn(page).turnState` is
`select a project first`, and no `POST /api/projects/.../turn` was recorded. `freshStatus` is
`select a project first`.

**Failure.** A blank sidebar with no wording; an error banner; a turn request sent with no project;
or a request to a path containing `null` or `undefined`.

### SIDE-5 — the GitHub connection state is readable in each of its forms (should)

**Intent.** The owner has to know whether the workspace can reach GitHub, and how to fix it, without
the page ever asking for a token.

**Steps.** For each row: fresh page on that scenario, wait for the list, read `readProjectList` and
the verification link's `href` and text.

| Scenario                          | `githubState`             | `githubDetail`                     | link                                     |
| --------------------------------- | ------------------------- | ---------------------------------- | ---------------------------------------- |
| `ready`                           | `connected`               | `octocat (owner-authorization)`    | no `href` attribute, empty text          |
| `github-awaiting-authorization`   | `awaiting-authorization`  | `enter code WDJB-MJHT at GitHub`   | `https://github.com/login/device`        |
| `github-disconnected`             | `disconnected`            | empty                              | no `href` attribute, empty text          |

**Assertion.** Each row matches. On the awaiting row, the anchor has `rel="noreferrer noopener"`
and `target="_blank"`. In no row does the sidebar contain an input whose name or label mentions a
token: evaluate that no `input` inside the sidebar has a label or placeholder matching
`/token|secret|password/i`.

**Failure.** A state of `unknown` when the server sent one; a `WDJB-MJHT` code shown with no
verification link to use it at; a live `href` left behind after the connection state changed; or any
credential field.

### SIDE-6 — connecting a repository reports its result and re-reads the list (should)

**Steps.**

1. Load the page. Click **Connect** with the field empty; read `connectStatus`.
2. Type `https://github.com/octocat/new-repo`, click **Connect**.
3. Wait until `connectStatus !== "connecting"`; read `connectStatus`, `readProjectList`, and
   `server.requests()`.

**Assertion.** Step 1: `connectStatus === "enter a repository url first"` and no POST recorded.
Step 3: `connectStatus === "connected"`; the recorded `POST /api/projects/connect` body is exactly
`{ "repositoryUrl": "https://github.com/octocat/new-repo" }`; a `GET /api/projects` follows it, so
the list came from the server; and the previously selected project is still selected afterwards
(`selected.length === 1`, unchanged).

**Failure.** A body carrying anything beyond the URL; a `connected` wording with no list re-read; or
a connect that resets the current selection and the reader's conversation.

---

## 4. Keyboard access

### KEY-1 — the tab order follows the page's document order, and skips what cannot be used (must)

**Intent.** The whole page must be operable with no mouse, in an order that matches what a reader
sees.

**Preconditions.** Scenario `ready`; viewport 1280x900; drawer closed; the first project selected.

**Steps.**

1. Load the page and wait for the project list.
2. Evaluate `document.body.focus()` then press `Tab` repeatedly (at most 20 times), reading
   `readFocus(page)` after each press, until focus returns to the first element or the cap is hit.

**Assertion.** The observed sequence of focused ids is exactly:
`refresh-status-button`, the drawer `summary` (tag `summary`), `project-sidebar-toggle`, the two
project buttons in list order (tag `button`, class contains `project-button`, `projectId` matching
the list order), `github-authorize-button`, `github-authorize-complete-button`,
`connect-repository-input`, `connect-project-button`, `prompt-input`, `send-turn-button`,
`fresh-thread-button`. `cancel-turn-button` never appears, because it is disabled. No id from
inside the closed drawer appears (`candidate-commit-input`, `activate-label-input`,
`rollback-label-input` and their buttons).

**Failure.** A focus stop on a disabled Cancel button; a stop inside the closed drawer; a project
button unreachable by keyboard; an order that jumps between columns; or focus landing on the page
body and going nowhere.

### KEY-2 — the drawer opens from the keyboard, and then its controls join the order (must)

**Steps.**

1. Tab to the drawer `summary` (two presses from `document.body`).
2. Press `Enter`. Read `readLayout(page).drawerOpen`.
3. Press `Tab` four times, reading `readFocus` after each.
4. Press `Space` on the summary again after tabbing back to it, and read `drawerOpen`.

**Assertion.** After `Enter`, `drawerOpen === true`. The next four focus stops are
`candidate-commit-input`, `submit-candidate-button`, `activate-label-input`, `activate-button`.
`Space` on the summary closes it (`drawerOpen === false`), and those ids leave the order again.

**Failure.** `Enter` or `Space` doing nothing; the drawer opening but its inputs not focusable;
or focus lost (an empty `readFocus().id` and tag `body`) after the toggle.

### KEY-3 — Control-Enter sends a turn from the prompt (must)

**Intent.** A keyboard reader must be able to run a turn without leaving the prompt.

**Steps.**

1. Focus `prompt-input` by tabbing to it (do not click), then insert the text
   `add a sidebar` with `Input.insertText`.
2. Press `Enter` with the `Control` modifier held.
3. Read `readTurn(page)` and the prompt's `value`, then wait for the terminal state and read
   `server.requests()`.

**Assertion.** Immediately after the key press, `turnState` is `running` and `sendDisabled` is
true. The prompt's `value` is empty (the page cleared it) and it does not contain a newline — the
modified key inserted no text. Exactly one `POST /api/projects/<id>/turn` was recorded, with body
`{ "prompt": "add a sidebar" }`. The turn reaches `saved · revision 4 · 6 messages`.

**Failure.** A newline inserted and no turn started; two turn requests (the key press and a click
both fired); a prompt still holding its text after the send; or a body carrying more than the
prompt.

### KEY-4 — a project can be chosen with the keyboard alone (must)

**Steps.**

1. Load the page, then tab to the second project button (as counted in KEY-1) and confirm
   `readFocus(page).projectId` is that entry's id.
2. Press `Enter`.
3. Wait until `readThread(page).state === "ok"`, then read `readProjectList` and `readThread`.

**Assertion.** The second entry is now the only `selected` one, its `aria-current` is `true`, the
conversation heading is its display name, and its own saved conversation is loaded (its project id
appears in the transcript text). Focus is still on the project button that was activated, so a
keyboard reader does not lose their place.

**Failure.** `Enter` not selecting; the selection changing but the thread not loading; or focus
jumping to the top of the document after activation.

### KEY-5 — the sidebar toggle states its own state, and focus is always visible (should)

**Steps.**

1. Tab to `project-sidebar-toggle` and read `readLayout(page)`.
2. Press `Enter`; read `readLayout` and `readFocus`.
3. Press `Enter` again; read `readLayout`.
4. For each of `refresh-status-button`, `project-sidebar-toggle`, `prompt-input`,
   `send-turn-button`: focus it from the keyboard and evaluate
   `getComputedStyle(document.activeElement).outlineStyle` and `outlineWidth`.

**Assertion.** Initially `toggleExpanded === "true"` and `toggleLabel === "Hide"`. After the first
`Enter`, `layoutClass === "sidebar-collapsed"`, `toggleExpanded === "false"`,
`toggleLabel === "Show projects"`, `sidebarWidth === 0`, and focus is still on the toggle. After the
second `Enter`, all three return to their first values and `sidebarWidth > 0`. In step 4, every
focused control reports a non-`none` `outlineStyle` with a width of at least 2 px.

**Failure.** A label and an `aria-expanded` value that disagree; a sidebar that keeps its box while
claiming to be hidden; focus moving off the toggle; or any control with no visible focus outline.

---

## 5. Narrow viewport

The stylesheet changes at `max-width: 52rem`, which is 832 px at the default root font size. These
cases use 420x900, well inside that.

### NAR-1 — below the breakpoint the conversation gets the full width (must)

**Steps.** Set the viewport to 420x900, load the page, wait for the project list, read
`readLayout(page)`.

**Assertion.** `viewportWidth` is about 420. `sidebarWidth > 0` and `conversationWidth > 0`. The
two are stacked, not side by side: `conversationTop >= sidebarBottom`. The conversation fills the
column: `conversationWidth >= viewportWidth - 40`, and `conversationLeft` is at most 20.
`document.scrollingElement.scrollWidth - clientWidth <= 1`, so there is no sideways scroll.

**Failure.** Two columns squeezed side by side; a conversation narrower than about two thirds of the
viewport; a horizontal scrollbar; or a sidebar with no box at all before anyone hid it.

### NAR-2 — hiding the sidebar on a narrow screen really removes it (must)

**Steps.**

1. At 420x900, load the page and click the toggle.
2. Read `readLayout(page)` and try `page.click` on the first project button.
3. Click the toggle again and read `readLayout`.

**Assertion.** After the first click, `sidebarWidth === 0` and `sidebarBottom` is 0 or negative —
the panel has no box, so it is genuinely gone rather than merely restyled. `toggleLabel` is
`Show projects` and `toggleExpanded` is `false`. The attempted click on the project button fails
with the harness's own `no visible box` error, which is the correct outcome for a hidden control.
`conversationWidth` is still at least `viewportWidth - 40`. After the second click the sidebar has a
box again and the project buttons are clickable.

**Failure.** A sidebar still occupying space; project buttons that a real mouse can still hit while
the panel claims to be hidden; or a conversation that shrinks when the sidebar goes away.

### NAR-3 — a long turn scrolls inside the transcript and leaves the composer reachable (must)

**Intent.** The rule that matters on a small screen: a long turn must not push the prompt off the
page.

**Steps.**

1. At 420x900, send a turn and wait for the terminal state.
2. Evaluate on the message list: `scrollHeight > clientHeight`, `clientHeight`, and
   `getBoundingClientRect().height`.
3. Evaluate the send button's rectangle and whether it is inside the viewport.
4. Click **Send turn** with an empty prompt with a real mouse click.
5. Evaluate `document.scrollingElement.scrollWidth - clientWidth`.

**Assertion.** The message list scrolls internally (`scrollHeight > clientHeight`) and its own
height is at most 60% of the viewport height plus a small tolerance. The send button's rectangle
is fully inside the viewport after the turn, and the click in step 4 succeeds with
`turnState === "type a prompt first"`. Horizontal overflow is at most 1 px.

**Failure.** A message list as tall as its content, which means the composer was pushed below the
fold; a send button outside the viewport; a click that throws; or sideways scroll caused by the
large tool output.

---

## 6. Wide viewport

### WID-1 — above the breakpoint the sidebar and the conversation are two columns (must)

**Steps.** Set the viewport to 1600x1000, load the page, wait for the project list, read
`readLayout(page)`.

**Assertion.** `sidebarRight <= conversationLeft`, measured — the columns really are side by side,
not merely styled to look that way. `sidebarWidth` is about 288 px (18 rem) within 2 px.
`conversationWidth > sidebarWidth`. The document is centred within the 78 rem body bound:
`sidebarWidth + conversationWidth <= 1248` and `conversationLeft > 100`, so the content is not
pinned to the left edge of a 1600 px window. No horizontal overflow.

**Failure.** A stacked layout above the breakpoint; overlapping boxes
(`sidebarRight > conversationLeft`); a conversation narrower than the sidebar; or content stretched
edge to edge past the 78 rem bound.

### WID-2 — a wide screen still bounds the transcript and keeps both controls in view (should)

**Steps.**

1. At 1600x1000, send a turn and wait for the terminal state.
2. Evaluate the message list's `clientHeight` and `scrollHeight`.
3. Evaluate the rectangles of `refresh-status-button` and `send-turn-button`.
4. Evaluate `document.scrollingElement.scrollHeight - clientHeight`.

**Assertion.** The message list scrolls internally, and its height is at most 60% of 1000 px plus a
tolerance. Both buttons' rectangles are inside the viewport, so the generation bar and the composer
are visible at once, which is what makes demo steps 3 to 5 readable in one window. Page-level
vertical scroll grew by less than one viewport height as a result of the ~200,000-character tool
output.

**Failure.** A transcript that grows the page instead of scrolling itself; a refresh button or a
send button pushed out of view; or page scroll height growing by many screens from one tool result.

### WID-3 — resizing across the breakpoint keeps the reader's state (should)

**Intent.** The layout may change; the selection, the conversation, and the drawer must not.

**Steps.**

1. At 1600x1000, load the page, select the second project, open the drawer, and record
   `readProjectList`, `readConversation(page).allText`, `readLayout(page).drawerOpen`.
2. Set the viewport to 420x900. Read all three again.
3. Set it back to 1600x1000. Read all three again, and read `server.requests()`.

**Assertion.** In all three readings, the same single entry is `selected` with `aria-current` true,
the transcript text is unchanged, and `drawerOpen === true`. The layout does change:
`conversationTop >= sidebarBottom` at 420 px and `sidebarRight <= conversationLeft` at 1600 px. No
extra `GET /api/projects` or thread request was recorded because of the resizes — a resize is not a
reload.

**Failure.** A lost selection; a cleared transcript; a drawer that closed itself; or new requests
issued by the resize, which would mean the page reloads state on layout changes.

---

## Gaps this set deliberately does not cover

- **Cloudflare Access.** The harness serves the page with no Access check, so nothing here proves
  the owner-only gate or the `invalid-configuration` fail-closed behavior. That needs a deployed
  environment.
- **A real turn.** Every turn here is a recorded frame script. Model behavior, the turn lease, and
  workspace file changes are proved elsewhere.
- **Transport failures and the error banner.** `#page-error` shows the `reportError` wording when a
  `fetch` rejects, and `#page-error:empty` hides the banner otherwise. Testing it needs a harness
  route that destroys the socket. GEN-8's step 3 gets close with a problem payload but does not
  exercise the rejected-fetch path. Add the scenario if the banner matters enough to gate on.
- **Two browsers at once.** ADR-0037 says a second browser must see what the Supervisor committed.
  That needs two `BrowserPage` instances against one server and is worth adding once the single-page
  cases pass.
