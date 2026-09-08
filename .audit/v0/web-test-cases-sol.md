# Owner page end-to-end web test cases

These cases test behavior that an owner can see or operate. They do not assert script state, CSS class names, or application element IDs. They also do not cover the deleted recovery report, turn-credit, or eligibility features.

## How to execute the cases

Use the real page from `src/page/` with the local stub owner API. Drive a fresh headless Chromium tab through CDP. Select controls by HTML role and accessible name, or by their associated visible label. Use `getBoundingClientRect()` only to measure rendered layout. For every case, fail on a console error, uncaught exception, failed same-origin page request that the case did not request, or Content Security Policy violation.

The current `smoke.mts` check loads a 1280 by 900 page, verifies its title and root, observes one API request, and checks browser errors. It covers only the boot and browser-error parts of `WIDE-1`; it does not fully cover any case below. Every case needs new driving code. Some chat cases can reuse `turn-fixture.mts`, but `smoke.mts` does not drive it.

When a case calls for a stub state that does not exist, add it to the browser-harness stub, not to the application. Generation cases need a stateful stub whose active generation and epoch change after accepted commands. The stub must also record request bodies, expose a test-only way for the driver to advance its state, and let the driver pause and release response frames. Assertions still read the page, except where a case explicitly compares a visible epoch with the request observed by the stub.

## Chat stream

### CHAT-1 [must]

**Intent.** Show that assistant text reaches the owner before the turn finishes instead of appearing only after the response closes.

**Preconditions.** Select the connected project and configure the stub to send one assistant text frame, pause with the response open, then send a second text frame and a `saved` terminal frame when released.

**CDP steps.** Set the viewport to 1280 by 900, load the page, wait for the selected project and saved thread to appear, type `Inspect the README` in the prompt, click `Send turn`, wait for the stub's first-frame barrier, and read the visible transcript without releasing the barrier. Release the stream, then wait for the saved terminal message.

**Observable assertion.** While the response is paused, the transcript contains the user's prompt and the first assistant text, the turn says `running`, `Send turn` is disabled, and `Cancel turn` is enabled. After release, the second text and a nonempty `saved` message appear in order.

**Failure.** Fail if the first assistant text is absent while the response is open, if the controls do not show a running turn, or if no saved terminal result appears after release.

**Harness.** New driving code and a pauseable stream fixture.

### CHAT-2 [must]

**Intent.** Render a coding turn as ordered assistant text, tool activity, command output, the harness-produced diff, and terminal success.

**Preconditions.** Use the current ready turn fixture, which sends read, patch, command, diff, and saved frames in that order.

**CDP steps.** Send `Add the project sidebar`, sample the transcript after each tool-result frame, wait for `saved`, open each tool disclosure with a real click, and read the visible summaries and output.

**Observable assertion.** Three distinct tool disclosures progress from `running…` to `done`; the command output is readable when opened; one separate transcript entry labeled `diff` contains the `src/routes/turns.ts` hunk with visible added and removed lines; and the saved terminal entry follows the diff.

**Failure.** Fail if a tool never leaves its running state, output is blank, the tool patch is mistaken for the turn diff, the diff is missing, or terminal success appears before the diff.

**Harness.** New driver; the existing ready fixture and page-query helpers can supply the data and snapshots.

### CHAT-3 [must]

**Intent.** Confirm that terminal success means the updated thread can be read again after a page reload.

**Preconditions.** The stub starts at revision 3 with two saved messages and advances to revision 4 with six messages only after it sends `saved`.

**CDP steps.** Load the project, record the visible revision and message count, complete one ready turn, wait for the quiet thread refresh, reload the page with `Page.reload`, and wait for the project thread to finish loading.

**Observable assertion.** The terminal result says `saved`, revision 4, and six messages; after reload the thread header still shows revision 4 and six messages, and the transcript contains nonempty saved conversation text.

**Failure.** Fail if success is inferred only from HTTP 200, if the header stays at revision 3, or if reload produces an empty transcript.

**Harness.** New driver; the current stateful thread fixture already supports the revision change.

### CHAT-4 [must]

**Intent.** Let a read-only turn finish without inventing a diff when no file changed.

**Preconditions.** Add a fixture that sends nonempty assistant text, a successful read tool call, and a `saved` terminal frame, with no `diff` or `diff-unavailable` frame.

**CDP steps.** Send `Summarize the README without changing files`, wait for the stream to finish, inspect every transcript entry, and then send a second short turn.

**Observable assertion.** The read-only answer, finished read tool, and saved terminal result are visible; no blank or fabricated diff entry exists; and the second turn starts normally.

**Failure.** Fail if the page renders nothing, waits forever for a diff, fabricates a diff, reports failure, or leaves the composer disabled.

**Harness.** New driving code and a no-diff fixture.

### CHAT-5 [must]

**Intent.** Keep a very long single-line command result readable without breaking or freezing the page.

**Preconditions.** Add a fixture whose successful `run_command` result is one 30,000-character line with unique start and end markers, followed by `saved`.

**CDP steps.** Start the turn, wait for the command summary to say `done`, open it, read its text and bounding box, query the document's scroll width and viewport width, press Tab until focus reaches `Cancel turn` or `Start fresh thread`, and wait for terminal success.

**Observable assertion.** The output begins with the start marker, has a visible `shortened for display` notice, does not show the end marker, wraps or scrolls inside its own output box without making the document wider than the viewport, keyboard focus still moves, and the turn ends saved.

**Failure.** Fail on blank output, unbounded full output, page-level horizontal overflow, an unresponsive focus sequence, or a missing terminal result.

**Harness.** New driving code and a single-line fixture; the existing large fixture has many short lines and does not cover this edge.

### CHAT-6 [must]

**Intent.** State why a changed-file turn could not produce its diff instead of leaving a silent gap.

**Preconditions.** Use the current `diff-unavailable` scenario.

**CDP steps.** Send a turn, wait for its terminal result, find the transcript entry labeled `diff`, and read that entry and the turn result.

**Observable assertion.** Exactly one diff entry says that the workspace held no Git repository, no made-up patch appears, and the turn ends with a nonempty saved result after the explanation.

**Failure.** Fail if the diff entry is missing or empty, if a made-up patch appears, or if the page reports success with no visible explanation.

**Harness.** New driver; the existing `diff-unavailable` fixture supplies the live frame.

### CHAT-7 [must]

**Intent.** Distinguish terminal turn failures from saved success and restore the composer after each one.

**Preconditions.** Use the existing `turn-failed`, `save-failed`, `stream-invalid`, `cancelled`, and `timed-out` scenarios one at a time in fresh pages.

**CDP steps.** For each scenario, send the same prompt, wait for its named terminal frame, read the terminal transcript entry and turn status, then try to start a ready turn without reloading.

**Observable assertion.** The page says respectively `failed: model-error · saved at revision 4`, `not saved: stale-revision`, `unreadable turn stream: malformed-frame`, `cancelled`, or `timed out`; none says plain `saved`; and `Send turn` becomes enabled before the ready turn starts.

**Failure.** Fail if any error is shown as success, is blank, leaves both action buttons disabled, or prevents the next turn.

**Harness.** New driver; all five fixtures already exist.

### CHAT-8 [must]

**Intent.** Warn when a successful HTTP stream closes without any terminal frame.

**Preconditions.** Add a fixture that sends visible assistant text and then closes the NDJSON body without a terminal frame.

**CDP steps.** Send a prompt, wait for the response to close, read the assistant message and turn status, and wait until the composer controls settle.

**Observable assertion.** The assistant text remains visible, the turn says `the turn stream ended without a terminal frame`, `Send turn` is enabled, and no saved terminal entry exists.

**Failure.** Fail if the page is empty, says saved, remains running, or silently returns to an idle blank status.

**Harness.** New driving code and an unterminated-stream fixture.

### CHAT-9 [should]

**Intent.** Cancel a live turn from the browser and prevent its late frames from changing the conversation.

**Preconditions.** Pause a stream after its first text frame and have the stub record a closed response while retaining later frames for an attempted release.

**CDP steps.** Send a prompt, wait for the first assistant text, click `Cancel turn`, wait for the response-close observation, release the remaining fixture frames, and watch the transcript for twice the normal frame interval.

**Observable assertion.** The status says `cancelled: this browser stopped the turn`, the cancel control disables, the pre-cancel text remains, and no post-cancel tool, diff, or saved frame appears.

**Failure.** Fail if late content arrives, the page claims saved, or the composer stays locked.

**Harness.** New driver and a pauseable stream fixture.

### CHAT-10 [should]

**Intent.** Reject a concurrent turn clearly without erasing the saved conversation.

**Preconditions.** Use the existing `turn-conflict` response and a selected project with a nonempty saved thread.

**CDP steps.** Record the current transcript text, send a prompt, wait for the refusal, and read the transcript and controls.

**Observable assertion.** The status says `busy: another turn holds this project`, the old transcript remains nonempty, no assistant or saved terminal entry is fabricated, and `Send turn` is enabled.

**Failure.** Fail if the refusal is blank or generic, the saved transcript disappears, or the page remains in a running state.

**Harness.** New driver; the existing conflict fixture supplies the response.

## Generation drawer

### GEN-1 [must]

**Intent.** Show the active generation and observed epoch before the owner opens any controls.

**Preconditions.** The status stub reports active generation 1, commit `abc123`, status `ready`, and epoch 3.

**CDP steps.** Load the page, wait for the status read to finish, and inspect the visible generation bar without opening the drawer.

**Observable assertion.** Generation 1, commit `abc123`, status `ready`, epoch 3, and a successful last-read state are nonempty and visible while the controls remain closed.

**Failure.** Fail if the bar is blank, reports `none`, hides the epoch, or requires opening the drawer.

**Harness.** New driving code; the current status fixture supplies the payload.

### GEN-2 [must]

**Intent.** Submit a passing harness commit and show its generation label and startup-check result without activating it.

**Preconditions.** The stateful stub starts with generation 1 active at epoch 3 and accepts commit `def456` as ready generation 2 without changing the active generation.

**CDP steps.** Open `Generation controls`, type `def456` in the `harness commit` field, click `Submit candidate`, wait for submission and status refresh, and read both the submission panel and generation bar.

**Observable assertion.** The result says `ok`, labeled generation 2, epoch after labeling 3, and `ready: startup check answered`; the active bar still says generation 1 at epoch 3.

**Failure.** Fail if preparation is blank, submission silently activates generation 2, or the active generation disappears.

**Harness.** New driver; the existing submit fixture can be reused after the stub becomes stateful.

### GEN-3 [must]

**Intent.** Keep the active generation serving when a candidate fails its cold-start check.

**Preconditions.** Generation 1 is active and ready; commit `broken456` receives generation 2 but its startup `GET /` check returns a failure such as `startup-check-failed`; the ready chat stream remains available through generation 1.

**CDP steps.** Open the drawer, submit `broken456`, wait for the preparation result, read the active generation bar, then send `Prove the old generation still serves` and pause after its first assistant frame before letting it finish.

**Observable assertion.** Submission names the rejected startup check, the active bar remains generation 1 with commit `abc123`, assistant text appears while the post-failure turn is still streaming, and that turn ends saved.

**Failure.** Fail if the page activates generation 2, clears or changes generation 1, cannot start the chat turn, buffers its response until close, or does not save it.

**Harness.** New stateful generation failure scenario and chat driver.

### GEN-4 [must]

**Intent.** Activate a ready candidate while keeping the selected project's current conversation.

**Preconditions.** Generation 2 has passed preparation, generation 1 is active at epoch 3, and the selected thread contains at least two visible messages.

**CDP steps.** Record the selected project, transcript text, revision, and message count; enter 2 in `generation label` under `Activate a generation`; click `Activate`; wait for the status refresh; then send a continuation prompt.

**Observable assertion.** Activation says `ok` with effect `activated`, the sent epoch shown to the owner is 3, the generation bar changes to generation 2 and a newer epoch, the selected project and prior transcript remain, and the continuation turn streams and saves.

**Failure.** Fail if activation loses the project or conversation, uses an unshown epoch, leaves the bar on generation 1, or breaks the next turn.

**Harness.** New stateful driver and stub.

### GEN-5 [must]

**Intent.** Reject an activation based on a stale epoch without changing the active generation.

**Preconditions.** The page has rendered generation 1 at epoch 3; before the click, a second test client advances backend generation-control state to epoch 4 while generation 1 stays active; generation 2 is ready.

**CDP steps.** Do not refresh the first page. Enter generation 2 and click `Activate`, compare the visible `epoch sent` with the stub's recorded request body, wait for the automatic status refresh, and read the result and active bar.

**Observable assertion.** The page sent the previously visible epoch 3, shows `rejected: stale-epoch`, leaves the effect blank, and refreshes the bar to epoch 4 with generation 1 still active.

**Failure.** Fail if the page substitutes epoch 4 before sending, reports success, changes the active generation, hides the rejection, or fails to refresh its displayed epoch.

**Harness.** New stateful stub, out-of-band mutation control, request recording, and driver.

### GEN-6 [must]

**Intent.** Roll back to an earlier ready generation without losing the current thread or project edit evidence.

**Preconditions.** Generation 2 is active at epoch 4; generation 1 is a ready generation that ran before; the selected thread contains a unique message from the earlier coding turn; and the workspace stub retains that turn's file change.

**CDP steps.** Record the selected project, thread revision, and unique conversation text; enter 1 under `Roll back to an earlier generation`; click `Roll back`; wait for refresh; reload the page; and send `Show the change that is still in the project` through a fixture that reads the retained workspace diff.

**Observable assertion.** Rollback says `ok` with effect `rolled-back`, the active bar shows generation 1 and a newer epoch, the same project and prior conversation reappear after reload, and the new turn streams the retained file change and ends saved.

**Failure.** Fail if rollback produces an empty thread, selects another project, loses the retained workspace change, leaves generation 2 active, or prevents the continuation.

**Harness.** New stateful stub and driver. A deployed version of this case should also retain server logs that prove rollback loaded the stored module map without a build, but that log check is outside the browser assertion.

### GEN-7 [should]

**Intent.** Make repeat submission and activation of the current generation visibly harmless.

**Preconditions.** Commit `abc123` is already labeled generation 1 and generation 1 is active at the currently displayed epoch.

**CDP steps.** Submit `abc123` again, record the returned label and active bar, then enter label 1 under activation and click `Activate` with the refreshed epoch.

**Observable assertion.** Submission returns generation 1 rather than creating another label; activation says `ok` with a no-change effect; and the active generation, selected project, and transcript remain unchanged.

**Failure.** Fail if a duplicate generation appears, epoch handling rejects the current request, or the no-op clears user state.

**Harness.** New stateful stub and driver.

### GEN-8 [should]

**Intent.** Block empty or invalid generation inputs before a request can appear to run.

**Preconditions.** Load a normal ready page and clear the stub's request log.

**CDP steps.** Open the drawer; click `Submit candidate` with an empty commit; click `Activate` with an empty label, `-1`, and `1.5` in separate attempts; do the same under rollback; then inspect the visible result text and stub request log.

**Observable assertion.** Empty submission says `enter a harness commit first`; every invalid label says `enter a generation label`; no generation-control POST reaches the stub; and the active generation remains visible.

**Failure.** Fail if a bad request is sent, the page shows `running`, an error is blank, or the active bar changes.

**Harness.** New driver; no new fixture response is needed.

## Project sidebar

### SIDE-1 [must]

**Intent.** List exactly the one connected GitHub project plus the harness project and select a usable default.

**Preconditions.** The project API returns one external repository named `hello-world` and one special harness project named `harness`, each with a nonempty displayed location and its own saved thread.

**CDP steps.** Load the page, wait for project loading to finish, count the visible project buttons, read each button's accessible name and repository/location text, and inspect the conversation heading and selected marker.

**Observable assertion.** Exactly two entries appear, one for `hello-world` and one for `harness`; there is no second external repository; exactly one entry is current; and its nonempty thread loads in the conversation.

**Failure.** Fail if either required entry is absent, a second external repository appears, selection is ambiguous, or the conversation remains `No project selected` or empty.

**Harness.** New project fixture and driver. The current fixture has two external repositories and no harness entry, so it must change for this case.

### SIDE-2 [must]

**Intent.** Select the harness project as an ordinary working-directory choice with its own current thread.

**Preconditions.** Use the two entries from `SIDE-1`; the harness thread contains a unique message naming `/workspace/harness`.

**CDP steps.** Click the `harness` project button, wait for its thread request, and read the current marker, conversation heading, revision, and first saved message.

**Observable assertion.** Only `harness` is current, the heading names it, its revision is nonempty, and its unique saved message appears; no extra session or workspace chooser appears.

**Failure.** Fail if the external project stays selected, the harness thread is blank, or the page presents a second clone/session workflow.

**Harness.** New fixture and driver.

### SIDE-3 [must]

**Intent.** Prevent frames from one project from appearing after the owner switches to the other project.

**Preconditions.** The external project can start a pauseable stream whose unreleased frames contain marker `EXTERNAL-LATE`; the harness thread contains marker `HARNESS-THREAD`.

**CDP steps.** Start a turn in `hello-world`, wait for its first frame, click `harness`, wait for `HARNESS-THREAD`, release the old stream, and observe the harness transcript for twice the normal frame interval.

**Observable assertion.** The harness remains selected, its saved thread stays visible, `EXTERNAL-LATE` never appears, and the harness composer becomes usable.

**Failure.** Fail if an old assistant, tool, diff, or terminal frame enters the harness conversation, or if switching projects leaves the controls locked.

**Harness.** New two-project pauseable fixture and driver.

### SIDE-4 [must]

**Intent.** Give an explicit empty state when the owner API returns no projects.

**Preconditions.** Add a project response with `ok: true`, `projects: []`, and a valid GitHub connection object.

**CDP steps.** Load the page, wait until project loading no longer says `reading`, inspect the sidebar list and conversation heading, type a prompt, and click `Send turn`.

**Observable assertion.** The sidebar says `no repository connected yet`, contains no project buttons, the conversation says `No project selected`, and sending says `select a project first` rather than doing nothing.

**Failure.** Fail if the empty state is blank, a stale project appears, the page auto-sends to an unnamed project, or the prompt action has no visible result.

**Harness.** New empty-project fixture and driver.

### SIDE-5 [must]

**Intent.** Keep sidebar visibility, toggle wording, and expanded state in agreement.

**Preconditions.** Load the normal two-entry project list at 1280 by 900.

**CDP steps.** Record the sidebar's visible box, click `Hide`, look for a visible `Show projects` control, activate it, and measure the sidebar again.

**Observable assertion.** Hiding removes the sidebar box and changes the toggle's accessible expanded state to false; a visible, focusable `Show projects` control remains; activating it restores the sidebar, label `Hide`, and expanded state true.

**Failure.** Fail if the sidebar remains visible while marked collapsed, if the only show control is hidden inside the collapsed sidebar, or if the list cannot be restored.

**Harness.** New driver. This case is likely to fail the current page because its toggle sits inside the element that collapse hides.

## Keyboard access

### KEY-1 [must]

**Intent.** Traverse every primary action in a stable, usable focus order without a mouse.

**Preconditions.** Load the wide page with the external project and harness entry, leave the generation drawer closed, and clear focus to the document body.

**CDP steps.** Send repeated CDP `Input.dispatchKeyEvent` Tab presses and, after each, read the active element's role and accessible name. Expect this order: `Refresh status`, `Generation controls`, `Hide`, external project, `harness`, `Authorize GitHub`, `I authorized it`, `repository url`, `Connect`, `prompt`, `Send turn`, `Start fresh thread`. Verify the disabled cancel button and closed drawer fields are skipped.

**Observable assertion.** Every expected control receives visible focus exactly once in that order, no invisible element receives focus, and the sequence reaches the composer without using a mouse.

**Failure.** Fail on a missing, repeated, hidden, or trapped focus target, an enabled control that cannot be reached, or a disabled/closed control that enters the sequence.

**Harness.** New focus-order driver; `BrowserPage.press` and `readFocus` already provide the low-level operations.

### KEY-2 [must]

**Intent.** Open the generation drawer and reach all generation controls with the keyboard alone.

**Preconditions.** Focus `Generation controls` on a ready page.

**CDP steps.** Press Enter, verify the disclosure reports expanded, then Tab through `harness commit`, `Submit candidate`, activation `generation label`, `Activate`, rollback `generation label`, and `Roll back`; type valid values using `Input.insertText` and activate each button with Enter.

**Observable assertion.** Focus visits the six controls in DOM order, each action produces its visible result, and focus never moves behind the open drawer or disappears.

**Failure.** Fail if Enter does not open the disclosure, any control is skipped or unreachable, or an action has no visible response.

**Harness.** New keyboard driver and stateful generation stub.

### KEY-3 [must]

**Intent.** Send a prompt with Control-Enter while focus stays in the prompt field.

**Preconditions.** Select a project and focus the prompt using only Tab.

**CDP steps.** Insert `Keyboard turn`, dispatch Enter with the CDP Control modifier, and wait at the first-frame barrier without clicking anything.

**Observable assertion.** The input clears, the user message appears, assistant text appears before release, the turn says running, and the stream ends saved after release.

**Failure.** Fail if the shortcut only inserts a newline, sends twice, does not stream, or leaves the prompt text in the field.

**Harness.** New keyboard driver and pauseable ready fixture.

### KEY-4 [should]

**Intent.** Select a project, hide and restore the sidebar, and confirm a fresh thread with keyboard actions only.

**Preconditions.** Load two projects with a nonempty selected thread and do not issue any mouse CDP command.

**CDP steps.** Tab to `harness` and press Enter; use Shift-Tab to reach `Hide` and press Enter; use the still-visible `Show projects` control to restore it; Tab to `Start fresh thread`, press Enter once, read the warning, and press Enter again.

**Observable assertion.** Harness selection loads its thread, sidebar hide and restore both work, the first fresh-thread press only warns, and the second clears the conversation and advances the visible revision while saying repository files are untouched.

**Failure.** Fail if any action needs a mouse, hide removes the only restore control, one press destroys the thread, or the second press gives no visible result.

**Harness.** New keyboard driver and two-project fixture.

## Narrow viewport

### NARROW-1 [must]

**Intent.** Stack the sidebar above the conversation at phone width without page-level horizontal overflow.

**Preconditions.** Use the normal project list and saved thread.

**CDP steps.** Set the viewport to 390 by 720 before navigation, load the page, wait for data, measure the sidebar and conversation rectangles, and compare `document.documentElement.scrollWidth` with its client width.

**Observable assertion.** Both panels have positive width, the sidebar bottom is at or above the conversation top, each panel fits within the 390-pixel viewport, the prompt and send button have visible boxes, and document scroll width does not exceed client width.

**Failure.** Fail if panels remain side by side, overlap, collapse to zero, extend off screen, or create horizontal page scrolling.

**Harness.** New layout assertions and narrow driver.

### NARROW-2 [must]

**Intent.** Let a phone-width owner hide and restore the project list without losing the conversation.

**Preconditions.** Load at 390 by 720 with a nonempty thread.

**CDP steps.** Record transcript text, click `Hide`, verify the sidebar has no rendered box, locate and click a visible `Show projects` control, and compare the restored transcript and selected project.

**Observable assertion.** The conversation stays visible and keeps its text while the sidebar is hidden; a visible restore control remains within the viewport; restoring returns the same selected project and project entries.

**Failure.** Fail if hiding also hides the restore control, clears the conversation, moves the composer off screen, or changes selection.

**Harness.** New narrow driver. Like `SIDE-5`, this should catch the current hidden-toggle defect.

### NARROW-3 [should]

**Intent.** Keep a long streamed transcript and an open generation drawer operable in a short phone viewport.

**Preconditions.** Set 390 by 640, use the ready large-output turn, and have generation controls available.

**CDP steps.** Complete the turn, open its command output, measure the transcript viewport and composer, open `Generation controls`, scroll each field and button into view, and activate the drawer summary and one input with keyboard commands.

**Observable assertion.** The transcript has its own vertical scrolling area no taller than 60 percent of the viewport, the composer remains reachable below it, long output stays inside the transcript, and every drawer control can be scrolled into view with positive dimensions and focused.

**Failure.** Fail if the transcript expands without bound, overlays the composer, forces horizontal page scrolling, or makes drawer controls unreachable.

**Harness.** New narrow driver; the existing large-output fixture can be reused.

## Wide viewport

### WIDE-1 [must]

**Intent.** Render a populated two-column owner page without browser or policy errors at desktop width.

**Preconditions.** Use the normal two-entry project list, ready status, and saved thread.

**CDP steps.** Set 1280 by 900, navigate to the page, wait until generation status, project list, and thread all stop reading, measure the sidebar and conversation, and collect console, exception, log, and CSP errors.

**Observable assertion.** The title is `cf-stumble`; generation, projects, and conversation all contain real data; sidebar and conversation have positive boxes side by side with a gap; and the browser reports no fault.

**Failure.** Fail if any main panel is blank, if the page would pass with only its shell, if panels overlap or stack, or if the browser reports an error.

**Harness.** Partially covered by `smoke.mts` for navigation, title, script execution, and browser faults. New populated-data and rectangle assertions are required.

### WIDE-2 [must]

**Intent.** Expand the conversation when the desktop sidebar is collapsed and restore the original two-column layout.

**Preconditions.** Load the populated page at 1440 by 900.

**CDP steps.** Record conversation width and transcript text, click `Hide`, measure again, use the visible `Show projects` control, and take a third measurement.

**Observable assertion.** The sidebar disappears, the conversation becomes wider, the transcript text does not change, a visible restore control remains, and restore returns two nonoverlapping columns with the same project selected.

**Failure.** Fail if conversation width does not grow, content is lost, the restore control vanishes, or restored panels overlap.

**Harness.** New wide-layout driver; this also exposes the current hidden-toggle defect.

### WIDE-3 [should]

**Intent.** Open all generation controls on desktop without pushing either main column off screen.

**Preconditions.** Load the page at 1280 by 900 with both project entries.

**CDP steps.** Open `Generation controls`, scroll its last rollback button into view, measure every labeled input and action button plus both main columns, then close the drawer with its summary.

**Observable assertion.** Every generation control has a positive visible box within the page width, labels remain associated with their inputs, sidebar and conversation retain their side-by-side positions, and closing the drawer restores the compact bar without changing selected project or transcript.

**Failure.** Fail if controls overlap, extend the document horizontally, detach from their labels, change the main-column layout, or alter conversation state.

**Harness.** New wide-layout driver.
