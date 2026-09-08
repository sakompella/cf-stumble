# Owner page end-to-end web test cases

## Index

| Surface           | Case ids       |   Must | Should |
| ----------------- | -------------- | -----: | -----: |
| Chat stream       | CHAT-1–CHAT-14 |      4 |     10 |
| Generation drawer | GEN-1–GEN-9    |      5 |      4 |
| Project sidebar   | SIDE-1–SIDE-6  |      2 |      4 |
| Keyboard access   | KEY-1–KEY-4    |      0 |      4 |
| Narrow viewport   | NAR-1–NAR-3    |      0 |      3 |
| Wide viewport     | WID-1–WID-4    |      1 |      3 |
| **Total**         | **40 cases**   | **12** | **28** |

## What the harness needs

Build these shared pieces in order before six agents add one case file per surface.

1. **A full runner and case utilities.** Add `tools/browser-harness/run.mts`, change
   `pnpm harness:browser` from the smoke entrypoint to that runner, and keep `smoke.mts` as the fast
   plumbing check. The runner must isolate every case in a fresh server and tab, set a viewport,
   impose timeouts, collect browser and unexpected same-origin request failures, and print the case
   id on failure.
2. **Shared CDP actions and assertions.** Extend `BrowserPage` with reload, Shift-Tab, accessible
   role/name lookup, and helpers that assert a visible box, expected click failure, no overflow,
   focus outline, and no browser fault. Add polling helpers that take atomic snapshots while a turn
   streams.
3. **A controllable, stateful stub.** Give the server test-only controls to clear/read requests,
   pause after a named frame, report that the barrier was reached, release frames, observe a closed
   response, and mutate generation state out of band. Keep status, candidate labels, active
   generation, epoch, and one thread per project in server state. Record request order and bodies.
4. **Baseline project data for sidebar, chat, keyboard, and layout cases.** Replace `spoon-knife`
   with a `harness` entry whose displayed location is `/workspace/harness`. Keep `hello-world` at
   `https://github.com/octocat/hello-world`. Give both ids distinct saved threads at revision 3
   with two messages; each first message must name its id and location. This fixture is also the
   baseline for `NAR-*` and `WID-*`.
5. **Turn data for chat, keyboard, and layout cases.** Preserve the ready read/patch/command/diff/
   saved sequence and existing terminal, refusal, and `diff-unavailable` variants. Add pauseable
   ready, no terminal frame, no diff frame, literal markup output, a 200,000-character single line
   with start/end markers, and a failed tool result. A project-switch variant must hold an
   `EXTERNAL-LATE` frame until the harness thread is visible.
6. **Generation data for generation and keyboard cases.** Start with generation 1, commit
   `abc123`, status `ready`, epoch 3. Model passing commit `def456` as ready generation 2 without
   activation, broken commit `broken456` as a named failed startup check, accepted activation,
   stale-epoch rejection with a newer status, rollback from active generation 2 to generation 1,
   and repeat submission/activation as no-ops.
7. **Negative project and GitHub data for sidebar cases.** Add `no-projects`, the existing connected,
   awaiting-authorization, and disconnected GitHub states, and a stateful connect result that adds
   `https://github.com/octocat/new-repo` without changing the current selection.
8. **Typed readers used by all surface files.** Extend `page-queries.mts` with one generation
   snapshot, ordered transcript entries, tool open/failed/output details, accessible focus names,
   element rectangles, transcript and document scroll metrics, link attributes, and the prompt
   value. Keep request-body assertions in the server, not in page text.

## Execution rules and current-tree note

Use the real page from `src/page/` behind the harness CSP. Drive real mouse and keyboard input.
Unless a case says otherwise, use `ready`, 1280×900, the first project, and wait for status,
projects, and thread reads to settle. Every case must also assert a nonempty named result and no
console error, uncaught exception, unexpected same-origin request failure, or CSP violation.
Selectors may use the page's exported id/class contract; assertions must read rendered behavior.

The inputs described different snapshots of the tree. The current tree has `README.md` and uses
`smoke.mts` for `pnpm harness:browser`; it has no `run.mts`. The current harness fixture still has
`hello-world` plus `spoon-knife`, not the harness entry. Both authors agreed the required product
state is one GitHub repository plus `/workspace/harness`; work on `work/harness-project` may make
that product behavior arrive before these cases land. Do not weaken SIDE-1 if it does.

## Chat stream

### CHAT-1 — saved conversation loads for the selected project

**Rank:** must  
**Source:** opus

**Intent.** Prove that opening a project shows its stored thread rather than an empty or different
conversation.

**Preconditions.** Use the baseline two-project fixture; select `hello-world`, whose thread is at
revision 3 with two messages that name its id.

**Steps.** Load the page; wait for the thread state to become `ok`; read the project heading,
thread facts, and transcript.

**Observable assertion.** The heading is `hello-world`; revision is `3`, turn active is `no`, and
message count is `2`. The transcript has a user message followed by an assistant message and
contains `octocat-hello-world`.

**Failure.** Fail on zero messages, a rejected/error thread state, wrong revision or count, or text
from the other project.

### CHAT-2 — text and tools appear before the stream closes

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Sol's pause barrier and Opus's non-decreasing samples because together they
prove both a specific open-stream observation and continued incremental rendering.

**Intent.** Catch a page that buffers the response until the body ends.

**Preconditions.** Use pauseable ready data: pause after the first text and one completed tool, then
release the remaining two tools, text, diff, and saved frame.

**Steps.** Send `Add the project sidebar`; wait for the barrier without releasing it; sample the
turn and transcript; release the stream; sample every 100 ms until it settles.

**Observable assertion.** At the barrier the prompt, first assistant text, and at least one tool are
visible while state is `running`, Send is disabled, and Cancel is enabled. Across at least three
running samples, assistant characters and tool count never decrease; the final tool count is 3 and
the second assistant text appears before terminal success.

**Failure.** Fail if partial content is absent at the barrier, counters decrease, all content appears
only after release, fewer than three tools finish, or running controls are wrong.

### CHAT-3 — coding output is ordered and the turn diff is distinct

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Sol's order and disclosure checks plus Opus's separate exact diff counts
because this rejects both missing output and a duplicated tool patch.

**Intent.** Render the demo's read, edit, check, command output, turn diff, and success in order.

**Preconditions.** Use the ready frame sequence.

**Steps.** Send a turn; sample after each tool result; wait for saved; open all three tool
disclosures with real clicks; read summaries, output, ordered entries, and diff metrics.

**Observable assertion.** Three tools progress from `running…` to `— done`; opened command output is
nonempty. Exactly one turn diff precedes the terminal entry, contains `src/routes/turns.ts` and
`parseProjectId`, and has 3 added, 2 removed, and 3 hunk lines. It excludes `markup.ts`. The tool
patch separately has 3 added, 1 removed, and 3 hunk lines.

**Failure.** Fail if a tool stays running, output is blank, success precedes the diff, the diff is
missing or duplicated, or tool and turn patches are confused.

### CHAT-4 — saved success is durable after refresh and reload

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's request-order assertion and Sol's full page reload because the latter
extends the same durability check across a new document.

**Intent.** Prove that only a saved frame reports success and that the stored thread agrees later.

**Preconditions.** Start at revision 3 with two messages; the server advances to revision 4 and six
messages only when it writes the saved frame.

**Steps.** Complete a ready turn; wait for the quiet thread reread; inspect request order; reload the
page; wait for the same project thread.

**Observable assertion.** State and the final terminal entry say exactly
`saved · revision 4 · 6 messages`. A thread GET follows the turn POST. Before and after reload the
header says revision 4 and six messages, saved conversation text is nonempty, and the streamed
view held all three tools before reload.

**Failure.** Fail on HTTP-derived success without a saved frame, no post-turn thread GET, revision 3,
a transcript erased by the quiet reread, or an empty/reverted thread after reload.

### CHAT-5 — non-success terminal frames remain distinct

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's exact problem styling and Sol's follow-up usability check because an
accurate error that leaves the composer locked is not usable.

**Intent.** Explain every terminal ending without making it look saved.

**Preconditions.** Run fresh pages for `turn-failed`, `save-failed`, `stream-invalid`, `cancelled`,
and `timed-out`.

**Steps.** Send the same prompt in each scenario; wait for its terminal frame; read state and final
entry; then switch to ready and start another turn.

**Observable assertion.** States are respectively `failed: model-error · saved at revision 4`,
`not saved: stale-revision`, `unreadable turn stream: malformed-frame`, `cancelled`, and
`timed out`. Each final entry is a problem terminal, none is plain saved, Send is restored, and a
ready turn can start. The save-failed thread remains at revision 3.

**Failure.** Fail on blank or shared wording, success styling, a moved save-failed revision, locked
controls, or inability to start the next turn.

### CHAT-6 — an unterminated stream is reported

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's retained-tool and thread checks because they prove the page preserves
all useful partial evidence after the warning.

**Intent.** Prevent a stream that closes without a terminal frame from silently succeeding or
remaining busy forever.

**Preconditions.** Use `no-terminal-frame`, which sends visible text and three tools, then closes.

**Steps.** Send a turn; wait up to 20 seconds for state to leave running; read the transcript,
controls, and thread.

**Observable assertion.** State is exactly `the turn stream ended without a terminal frame`.
Partial text and three tools remain, no terminal entry exists, Send is enabled, Cancel is disabled,
and thread turn-active is `no`.

**Failure.** Fail on saved, stuck running, blank/cleared partial output, a fabricated terminal, or
locked controls.

### CHAT-7 — browser cancellation aborts and ignores late frames

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's pause/release race check plus Opus's unchanged-thread assertion because
they prove both UI isolation and no accidental save.

**Intent.** Make Cancel stop the live response without allowing late content to mutate the thread.

**Preconditions.** Pause after the first text/tool; retain later frames for attempted release and
observe the response close.

**Steps.** Send; wait for partial output; click `Cancel turn`; wait for response close and settled
controls; release the retained frames; observe for twice the normal frame interval; reread thread.

**Observable assertion.** State says `cancelled: this browser stopped the turn`; partial output
remains, no later tool/diff/saved entry appears, Send is enabled, Cancel is disabled, no page error
appears, and thread stays revision 3 with two messages.

**Failure.** Fail if late content arrives, state says saved, revision advances, an error banner
appears, or the composer stays locked.

### CHAT-8 — HTTP turn refusals use owner-facing wording

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's second refusal and no-fabricated-terminal checks because Sol covered
only the concurrent-turn branch.

**Intent.** Translate a pre-stream refusal without erasing the saved conversation.

**Preconditions.** Use nonempty threads with `turn-conflict` and `no-active-generation` in fresh
runs.

**Steps.** Record the transcript; send a prompt; wait for the refusal; read transcript, state,
controls, and request log.

**Observable assertion.** Conflict says `busy: another turn holds this project`; missing generation
says `no active generation: activate one in the generation controls`. The old transcript and typed
prompt remain visible, no tool or terminal entry is fabricated, and Send is enabled.

**Failure.** Fail on raw codes/HTTP text, blank state, erased saved text, a fabricated terminal, or
running controls.

### CHAT-9 — diff-unavailable explains the missing patch

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's exact counts and exact saved result because they rule out empty and
made-up diff blocks.

**Intent.** Tell the reader why a changed-file turn could not obtain its workspace diff.

**Preconditions.** Use `diff-unavailable`.

**Steps.** Send a turn; wait for terminal state; inspect diff entries and state.

**Observable assertion.** Exactly one unavailable entry contains
`the workspace held no git repository`; no normal diff or diff lines exist; the turn still ends
`saved · revision 4 · 6 messages` after the explanation.

**Failure.** Fail on a missing/empty explanation, any invented patch, or a failed/blank ending.

### CHAT-10 — a read-only turn needs no diff frame

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's second-turn usability check and Opus's zero-entry counts because both
absence and recovery matter.

**Intent.** Let a no-change turn finish without inventing or waiting for a diff.

**Preconditions.** Use `no-diff`: nonempty text, a successful read tool, and saved, with neither
diff frame kind.

**Steps.** Send `Summarize the README without changing files`; wait for saved; inspect entries and
controls; start a second short turn.

**Observable assertion.** Text, finished read tool, and exact saved result appear; normal and
unavailable diff counts are zero; no blank placeholder exists; the second turn starts normally.

**Failure.** Fail on blank output, fabricated diff, stuck running, failure status, missing tools, or
a disabled composer.

### CHAT-11 — repository and model output remains literal text

**Rank:** should  
**Source:** opus

**Intent.** Prevent untrusted turn output from becoming executable page markup.

**Preconditions.** Use `markup-output` with an image `onerror` tool result and a script-shaped text
frame; record title `cf-stumble`.

**Steps.** Complete the turn; count `img` and `script` descendants inside the transcript; read its
text and title.

**Observable assertion.** The descendant count is zero, title stays `cf-stumble`, and transcript
text contains the literal `<img src=x onerror=` and `<script>document.title=` strings.

**Failure.** Fail on created markup, changed title, missing quoted text, CSP fault, or console error.

### CHAT-12 — a long single line is bounded

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's 200,000-character bound and real composer click plus Sol's unique
markers and keyboard-progress check for the stronger freeze and truncation proof.

**Intent.** Keep command output readable without widening or freezing the page.

**Preconditions.** Use a successful 200,000-character single-line tool result with unique start and
end markers and `truncated: false`.

**Steps.** Complete the turn; open the tool; read output text/length and note; measure horizontal
overflow; Tab to a later control; click Send with an empty prompt.

**Observable assertion.** Output begins with the start marker, omits the end marker, includes
`shortened for display`, and renders at most 20,100 characters. Document overflow is at most 1 px,
keyboard focus advances, the Send click succeeds, and state becomes `type a prompt first`.

**Failure.** Fail on full or blank output, missing note, end marker, page overflow, frozen focus, or
an unreachable composer.

### CHAT-13 — tool disclosures are compact and expose failures

**Rank:** should  
**Source:** opus

**Intent.** Keep successful output collapsed while making a failed tool immediately visible.

**Preconditions.** Run ready and `tool-failed` separately.

**Steps.** On ready, finish the turn, inspect disclosures, then click the third summary. On failed,
finish and inspect the failed disclosure.

**Observable assertion.** Ready has three closed tools whose summaries end `— done`; opening one
makes exactly one open. The large result has one server-truncated and one display-shortened note.
The failed tool is open, visibly failed, contains a short error body, and ends `— failed`.

**Failure.** Fail if successful tools arrive open, a summary stays running, truncation notes are
missing, or a failed tool is collapsed/unmarked.

### CHAT-14 — fresh thread requires confirmation and no running turn

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's running-turn guard and exact request count because Sol only covered
the two-keypress confirmation path.

**Intent.** Prevent one click or a live turn from replacing the current conversation.

**Preconditions.** Use a nonempty ready thread.

**Steps.** During a turn, activate `Start fresh thread`; after saved, activate it once and inspect;
activate it again and wait for refresh; inspect requests and conversation.

**Observable assertion.** During the turn it says `a turn is running; cancel it first` and sends no
fresh request. First post-turn activation says `click again to replace this conversation` and
changes nothing. Second says `fresh thread started; repository files are untouched`, sends exactly
one fresh POST, advances revision to 5, and shows zero messages.

**Failure.** Fail on reset while running, clearing after one activation, multiple POSTs, unchanged
revision, or nonempty conversation after confirmation.

## Generation drawer

### GEN-1 — active generation stays visible while controls are closed

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's measured closed/open boxes because it strengthens Sol's visibility
check with proof that hidden controls are not mouse-reachable.

**Intent.** Show demo step 1 immediately while keeping controls one disclosure away.

**Preconditions.** Status returns generation 1, commit `abc123`, ready, epoch 3.

**Steps.** Load; read the active bar and drawer; measure Submit; open `Generation controls`; measure
again and click Submit.

**Observable assertion.** Before opening, the exact four generation values and last read `ok` are
visible, drawer is closed, and Submit has no box. After opening, the bar remains visible, drawer is
open, and Submit has a clickable box.

**Failure.** Fail on blank/none values, hidden bar, initially open controls, or unreachable controls.

### GEN-2 — passing submission labels but does not activate

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's exact request body/order and Sol's unchanged active bar because these
separate submission from activation.

**Intent.** Report the label and cold-start result for demo step 4 without changing what serves.

**Preconditions.** Generation 1 is active at epoch 3; `def456` becomes ready generation 2.

**Steps.** Open controls; submit `def456`; wait for result and status refresh; inspect result, bar,
and requests.

**Observable assertion.** Result is `ok`, label `2`, labeling epoch `3`, preparation
`ready: startup check answered`. Exactly one submit POST has `{ "harnessCommit": "def456" }`; a
status GET follows. Active remains generation 1, `abc123`, ready, epoch 3.

**Failure.** Fail on blank preparation, extra request fields, no refresh, automatic activation, or
changed active state.

### GEN-3 — failed candidate leaves the active generation serving

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Sol's pauseable post-failure turn plus Opus's exact unchanged generation
facts because this proves serving behavior, not only labels.

**Intent.** Prove demo step 6 and the owner's failed-candidate evidence.

**Preconditions.** `broken456` is labeled generation 2 but its startup GET fails with a nonempty
reason; generation 1 remains active; ready chat is pauseable.

**Steps.** Record the bar; submit `broken456`; read preparation and bar; close controls; send a turn;
observe assistant text at the barrier; release and finish.

**Observable assertion.** Submission records a named rejected startup check. Active remains label 1,
commit `abc123`, ready, epoch 3. Assistant text streams after the failure and the turn saves at
revision 4 with six messages; no page error appears.

**Failure.** Fail if candidate 2 activates, the old bar changes/clears, failure reason is blank, chat
buffers or cannot start, or the turn does not save.

### GEN-4 — activation sends the shown epoch and preserves conversation

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's exact server-recorded body and Sol's continuation turn because the
page must prove both concurrency input and demo step 5 continuity.

**Intent.** Activate a ready candidate while keeping the selected project and conversation.

**Preconditions.** Generation 2 is ready; generation 1 is active at epoch 3; selected thread has two
messages.

**Steps.** Record selection/transcript; activate label 2; wait for automatic status refresh; inspect
request/result/bar; send and finish a continuation.

**Observable assertion.** POST body is exactly `{ "observedEpoch": 3, "label": 2 }`; result is `ok`,
effect `activated`, sent epoch `3`; bar changes to generation 2 at epoch 4. Selection and prior
text remain, and continuation streams and saves.

**Failure.** Fail on a different/extra body field, stale bar, lost project/thread, or broken next
turn.

### GEN-5 — stale activation refreshes automatically

**Rank:** should  
**Source:** sol  
**Conflict:** Sol expects the control's built-in status refresh to expose epoch 4 immediately;
Opus only required recovery after the owner clicks Refresh. GEN-6 retains that second expectation.

**Intent.** Reject a stale observed epoch without changing the active generation.

**Preconditions.** Page displays generation 1 at epoch 3; mutate backend to epoch 4 without changing
the active generation; generation 2 is ready.

**Steps.** Without refreshing, activate label 2; inspect recorded body, result, effect, and bar after
the action settles.

**Observable assertion.** The request sent visible epoch 3, result is `rejected: stale-epoch`, effect
is blank, and the automatic GET refreshes the bar to epoch 4 with generation 1 still active.

**Failure.** Fail if epoch 4 is substituted before send, result is success/blank, effect is stale,
active changes, or automatic refresh does not expose epoch 4.

### GEN-6 — manual refresh recovers after stale rejection

**Rank:** should  
**Source:** opus  
**Conflict:** This preserves Opus's explicit manual-refresh expectation alongside GEN-5's stricter
automatic-refresh expectation.

**Intent.** Keep the owner-operated refresh useful after a concurrency rejection.

**Preconditions.** Use stale-epoch data; retain epoch 4 as the server truth after rejection.

**Steps.** Attempt activation from displayed epoch 3; after rejection, click `Refresh status`; wait
for last read `ok`; inspect bar and control result.

**Observable assertion.** Activation remains `rejected: stale-epoch`, effect stays empty, sent epoch
stays `3`, and manual refresh shows epoch 4 and the server's unchanged active generation.

**Failure.** Fail if refresh hides the rejection, leaves stale epoch, invents the requested active
label, or raises a browser error.

### GEN-7 — rollback restores the earlier generation without losing edit evidence

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Sol's stronger active-2 precondition, reload, and retained-edit continuation;
Opus's endpoint/body separation remains to catch an activation alias.

**Intent.** Prove demo step 7 and the owner's rollback persistence evidence.

**Preconditions.** Generation 2 is active at epoch 4; generation 1 is ready; selected thread and
workspace response contain unique earlier-turn markers.

**Steps.** Record project/thread; roll back label 1; inspect requests/result/bar; reload; wait for
thread; send a fixture turn that reports the retained edit.

**Observable assertion.** Only rollback POST is sent, exactly with `{ "observedEpoch": 4,
"label": 1 }`; result is `ok`, effect `rolled-back`, sent epoch `4`; bar becomes generation 1 at
epoch 5. After reload the same project, revision, conversation marker, and retained edit appear;
the new turn saves. Activate fields remain empty.

**Failure.** Fail if activation endpoint is used, generation 2 remains active, thread/project/edit
is lost, activate output is polluted, or continuation fails.

### GEN-8 — repeated commands are harmless

**Rank:** should  
**Source:** sol

**Intent.** Show idempotent submission and activation without changing reader state.

**Preconditions.** Commit `abc123` is generation 1 and generation 1 is active at the displayed epoch.

**Steps.** Submit `abc123`; record result/bar; activate label 1 using refreshed epoch; inspect result,
selection, and transcript.

**Observable assertion.** Submission returns label 1 without a duplicate; activation returns `ok`
with a no-change effect; active generation, selected project, and transcript are unchanged.

**Failure.** Fail on a duplicate label, stale rejection of the current epoch, false changed effect,
or cleared user state.

### GEN-9 — invalid or missing control input sends nothing

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's negative/fractional labels and Opus's missing-epoch guard because they
exercise different local validation branches.

**Intent.** Refuse incomplete generation commands before they reach the Supervisor.

**Preconditions.** Use ready for empty/invalid values; use a status-problem variant for missing epoch;
clear request records before each attempt.

**Steps.** Submit empty commit. Try activate and rollback with empty, `-1`, and `1.5`. On the
status-problem page, try activate label 2.

**Observable assertion.** Empty commit says `enter a harness commit first`; each invalid label says
`enter a generation label`; missing epoch says `refresh the status first`. No generation POST is
recorded and the prior active bar does not change.

**Failure.** Fail on any POST, running/blank status, a body containing null/NaN/empty values, or
changed active state.

## Project sidebar

### SIDE-1 — list one repository plus the harness and choose a default

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's exact GitHub/status facts and Sol's nonempty default-thread check
because both catalog identity and usability define demo step 2.

**Intent.** Present exactly the two allowed working-directory choices.

**Preconditions.** Baseline project fixture: `hello-world` URL plus `harness` at
`/workspace/harness`, each with a saved thread.

**Steps.** Load; wait for list; read visible labels, current markers, GitHub state, heading, and
thread.

**Observable assertion.** Exactly two buttons appear, one with the GitHub URL and one with
`/workspace/harness`; no second external repository appears. Status is `2 connected`; GitHub says
`connected` and `octocat (owner-authorization)`. Exactly one entry is current with
`aria-current=true`, and its nonempty thread/heading agree.

**Failure.** Fail on missing harness, `spoon-knife` or any third entry, missing locations, ambiguous
selection, reading status, or blank/default-mismatched thread.

### SIDE-2 — selecting harness loads its own thread

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's request-order and old-id exclusion plus Sol's explicit no-extra-chooser
check because the harness is only a normal project choice.

**Intent.** Select `/workspace/harness` without a second session or clone workflow.

**Preconditions.** Both baseline threads contain distinct id/location markers.

**Steps.** Record the external transcript; click harness; wait for its heading/thread; inspect list,
transcript, and requests.

**Observable assertion.** Only harness is current; heading names it; revision is nonempty; transcript
contains its id and `/workspace/harness` but not the external id. A harness thread GET follows the
click, and no extra session/workspace chooser appears.

**Failure.** Fail on stale selection/text, both entries current, blank thread, no harness GET, or an
extra clone/session flow.

### SIDE-3 — switching projects rejects late frames

**Rank:** should  
**Source:** sol

**Intent.** Prevent a response from the old project from entering the newly selected conversation.

**Preconditions.** Pause an external turn after one frame; later frames contain `EXTERNAL-LATE`;
harness thread contains `HARNESS-THREAD`.

**Steps.** Start the external turn; reach barrier; select harness; wait for its thread; release the
old response; observe twice the frame interval.

**Observable assertion.** Harness remains sole current project; `HARNESS-THREAD` stays visible;
`EXTERNAL-LATE` and old tool/diff/terminal entries never appear; harness composer is usable.

**Failure.** Fail on cross-project content, selection reversal, erased harness thread, or locked
controls.

### SIDE-4 — empty project list has an explicit safe state

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's fresh-thread and no-request checks because they test both actions that
need a selected project.

**Intent.** Explain a fresh account without sending requests to an unnamed project.

**Preconditions.** `no-projects` returns an empty list and valid connected GitHub data.

**Steps.** Load; wait past reading; inspect list/thread; enter a prompt and Send; activate fresh
thread; inspect requests.

**Observable assertion.** Sidebar says `no repository connected yet` with zero buttons; heading is
`No project selected`; thread and both actions say `select a project first`; page error is empty;
no turn/fresh POST or path containing null/undefined appears.

**Failure.** Fail on blank state, stale project, error banner, silent action, or malformed request.

### SIDE-5 — GitHub states and connect action remain safe

**Rank:** should  
**Source:** opus

**Intent.** Show connection state and connect a repository without asking the browser for a token.

**Preconditions.** Use connected, awaiting-authorization, and disconnected states; connect returns
`new-repo` and list reread keeps selection.

**Steps.** In each state read detail/link and scan labeled inputs for token/secret/password. In
connected, click Connect empty, then submit `https://github.com/octocat/new-repo`; inspect requests
and refreshed list.

**Observable assertion.** Connected shows `octocat (owner-authorization)` with no link;
awaiting shows code `WDJB-MJHT` and the GitHub device link with `_blank` plus noreferrer/noopener;
disconnected has empty detail/link. No credential input exists. Empty connect sends nothing and
says `enter a repository url first`; valid connect posts only that URL, says `connected`, rereads
projects, and preserves selection.

**Failure.** Fail on unknown/stale state, missing or live-wrong link, credential field, bad/extra
POST body, no reread, or lost selection.

### SIDE-6 — collapse and restore keep state and a reachable toggle

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's requirement that the restore control remain visibly reachable because
Opus's second click cannot occur if the toggle was hidden with the sidebar.

**Intent.** Keep sidebar visibility, toggle wording, expanded state, and conversation in agreement.

**Preconditions.** Use the populated 1280×900 page and record transcript/selection.

**Steps.** Activate `Hide`; measure sidebar and find/focus `Show projects`; activate it; inspect
layout, transcript, and selection.

**Observable assertion.** Hidden sidebar has no box; toggle remains visible/focusable, says
`Show projects`, and has `aria-expanded=false`. Restore returns a positive sidebar box, `Hide`, and
true. Transcript and selection never change.

**Failure.** Fail if the sidebar occupies space, the only restore control disappears inside it,
wording and ARIA disagree, or restore changes user state.

## Keyboard access

### KEY-1 — closed-page tab order is complete and visible

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's exact ids/project order and focus-outline measurement plus Sol's
accessible-name reading because together they catch hidden and unlabeled stops.

**Intent.** Reach every primary action in document order without a mouse.

**Preconditions.** Baseline wide page; drawer closed; body focused.

**Steps.** Press Tab until focus wraps; after each press read id, role/name, visibility, and outline.

**Observable assertion.** Order is Refresh status, Generation controls, Hide, external project,
harness, Authorize GitHub, I authorized it, repository URL, Connect, prompt, Send turn, Start fresh
thread. Cancel and closed generation fields are skipped. Every stop is visible, correctly named,
and has at least a 2 px non-none focus outline.

**Failure.** Fail on missing/repeated/hidden/unlabeled stops, wrong column order, disabled/closed
controls in order, focus trap, or invisible focus.

### KEY-2 — keyboard opens and operates all generation controls

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's full six-control traversal and action results because Opus stopped
after the first four controls.

**Intent.** Operate submission, activation, and rollback without a mouse.

**Preconditions.** Ready stateful generation data; focus `Generation controls`.

**Steps.** Press Enter; Tab through commit, Submit, activation label, Activate, rollback label, Roll
back; insert valid values and activate each button with Enter; return to summary and press Space.

**Observable assertion.** Drawer opens; the six stops occur in DOM order and each action has a
visible result; focus never disappears or enters a hidden element. Space closes the drawer and its
controls leave tab order.

**Failure.** Fail if disclosure keys do nothing, a control is skipped/unreachable, an action is
silent, focus is lost, or closed controls remain reachable.

### KEY-3 — Control-Enter sends exactly once

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's pauseable streaming proof plus Opus's exact request body/count because
they reject both a dead shortcut and a double send.

**Intent.** Send from the prompt while keyboard focus remains there.

**Preconditions.** Select a project; use pauseable ready.

**Steps.** Tab to prompt; insert `Keyboard turn`; press Control-Enter; inspect immediately and at the
barrier; release; finish; inspect requests.

**Observable assertion.** Input clears without a newline; user text and pre-release assistant text
appear; state is running with Send disabled; exactly one turn POST contains only
`{ "prompt": "Keyboard turn" }`; terminal state is saved.

**Failure.** Fail on newline-only behavior, retained input, no stream, two requests, extra body
fields, or no saved end.

### KEY-4 — project, sidebar, and fresh thread work with keys only

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's full no-mouse route and Opus's focus-retention assertion after project
selection.

**Intent.** Complete the remaining destructive/navigation actions with keyboard input only.

**Preconditions.** Baseline nonempty page; issue no mouse CDP command.

**Steps.** Tab to harness and Enter; Shift-Tab to Hide and Enter; use visible Show projects to
restore; Tab to Start fresh thread and press Enter twice, reading state between presses.

**Observable assertion.** Harness alone becomes current, its thread loads, and focus stays on its
button. Hide/restore keep a visible toggle and state. First fresh activation only warns; second
clears messages, advances revision, and says repository files are untouched.

**Failure.** Fail if any action needs a mouse, focus jumps away, restore vanishes, one press destroys
the thread, or confirmed reset has no result.

## Narrow viewport

### NAR-1 — phone width stacks panels without overflow

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's full-column numeric bounds and Sol's prompt/button visibility because
both content and composer must fit.

**Intent.** Give the conversation the phone width below the 52 rem breakpoint.

**Preconditions.** Baseline data; set 390×720 before navigation.

**Steps.** Load and settle; measure sidebar, conversation, prompt, Send, viewport, and document
scroll width.

**Observable assertion.** Both panels have positive widths and sidebar bottom is at or above
conversation top. Conversation is at least viewport minus 40 px and starts within 20 px; prompt and
Send have visible boxes; horizontal overflow is at most 1 px.

**Failure.** Fail on squeezed side-by-side or overlapping panels, zero/off-screen controls, a narrow
conversation, or horizontal scroll.

### NAR-2 — phone sidebar can hide and restore without data loss

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's visible restore-control requirement and Opus's real-click rejection for
a hidden project button because they prove the panel truly left hit testing.

**Intent.** Hide the project list while leaving the conversation and restore action usable.

**Preconditions.** Baseline nonempty page at 390×720.

**Steps.** Record text/selection; Hide; measure and attempt a real click on a project button; activate
the visible restore control; remeasure and compare state.

**Observable assertion.** Sidebar box is zero/absent, its project click fails for no visible box,
conversation remains full width with unchanged text, and a visible `Show projects` control remains.
Restore returns the same entries/selection and clickable boxes.

**Failure.** Fail if hidden content occupies space or receives clicks, restore control disappears,
conversation shrinks/clears, or selection changes.

### NAR-3 — long transcript and drawer stay operable on a short phone

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's real composer click and Sol's open-drawer traversal because these test
the two independent vertical pressure points.

**Intent.** Bound streamed output without burying the composer or generation controls.

**Preconditions.** Ready large output at 390×640.

**Steps.** Finish turn; open command output; measure transcript/composer and overflow; click Send
empty; open generation controls; scroll each field/button into view and focus one with keys.

**Observable assertion.** Transcript scrolls internally and is no taller than 60% of viewport plus
tolerance; output stays inside it; Send is inside viewport, clickable, and says `type a prompt
first`; no horizontal overflow occurs. Every drawer control can obtain a positive visible box and
keyboard focus.

**Failure.** Fail on unbounded transcript, overlaid/off-screen composer, sideways scroll, failed real
click, or unreachable drawer control.

## Wide viewport

### WID-1 — populated desktop is a bounded two-column page

**Rank:** must  
**Source:** both  
**Merge choice:** Keep Opus's 78 rem and 18 rem measurements plus Sol's populated-data checks because
a correctly sized empty shell must not pass.

**Intent.** Render the real owner information in two columns without policy errors.

**Preconditions.** Baseline data at 1600×1000.

**Steps.** Load and settle all reads; measure panels/body/overflow; inspect title and data.

**Observable assertion.** Title is `cf-stumble`; active generation, two projects, and conversation
are nonempty. Sidebar ends before conversation begins, is 288±2 px wide, and conversation is wider.
Combined content is at most 1248 px and starts over 100 px from the window edge. No horizontal
overflow or browser fault exists.

**Failure.** Fail on blank data, stacked/overlapping panels, wrong relative widths, edge-to-edge
stretch, overflow, or browser/CSP error.

### WID-2 — desktop collapse expands conversation and restores layout

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Sol's before/after width comparison because it strengthens the shared
visibility check with the intended use of freed space.

**Intent.** Use the sidebar's desktop space without losing conversation state.

**Preconditions.** Populated page at 1440×900.

**Steps.** Record width/text/selection; Hide; measure conversation and restore control; restore;
remeasure.

**Observable assertion.** Sidebar disappears, conversation becomes wider, visible Show projects
remains, and transcript/selection stay unchanged. Restore returns two nonoverlapping columns and the
original selection.

**Failure.** Fail if width does not grow, restore vanishes, content changes, or restored panels
overlap.

### WID-3 — long transcript and open controls fit one desktop view

**Rank:** should  
**Source:** both  
**Merge choice:** Keep Opus's viewport/button and page-growth bounds plus Sol's control/label layout
checks for a complete desktop operability assertion.

**Intent.** Keep demo controls and long command output readable without breaking the columns.

**Preconditions.** Baseline page at 1600×1000 with ready large output.

**Steps.** Finish turn; measure transcript and Refresh/Send; open controls; scroll to rollback;
measure each labeled control and both columns; close drawer.

**Observable assertion.** Transcript scrolls internally at no more than 60% viewport height; Refresh
and Send are inside the viewport; page height grows by less than one viewport. All generation
controls have positive boxes within page width and associated labels; columns remain side by side.
Closing controls preserves project/transcript.

**Failure.** Fail on page-sized transcript growth, off-screen main controls, horizontal overflow,
overlapping/detached drawer controls, changed columns, or lost state.

### WID-4 — resizing across the breakpoint preserves state

**Rank:** should  
**Source:** opus

**Intent.** Let layout change without reloading selection, conversation, or drawer state.

**Preconditions.** At 1600×1000 select harness and open generation controls.

**Steps.** Record selection/transcript/drawer and request counts; resize to 420×900 and inspect;
resize back and inspect.

**Observable assertion.** The same sole selected project, transcript text, and open drawer remain at
all sizes. Panels stack at 420 and return side by side at 1600. Resize issues no extra projects or
thread GET.

**Failure.** Fail on lost selection/text, closed drawer, wrong responsive layout, or state-fetching
requests caused only by resize.
