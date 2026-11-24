# Run the agent loop on Pi Durable with Supervisor-owned storage

> **Review:** Agent-only

The main harness runs its agent loop on Pi Durable (`@earendil-works/pi-durable`, with `pi-ai` and
`chord`), pinned to one exact version in `package.json`. Pi Durable owns the agent loop, the thread
store and the run, so cf-stumble keeps no Pi core, thread store, turn lease or turn stream of its
own. A run outlives the browser: the browser sends a message, the generation works on it in the
background, and the browser watches the conversation.

**The page watches Pi Durable's committed view.** The facet streams `conversation.watch()`, Pi
Durable's committed conversation view. The stream is JSON lines. The first line is `[["r", view]]`, a replace of the whole
view; each later line is the array of delta ops that turns the previous view into the next (Chord's
`delta` format, applied on the page with `applyImmutable`). The view holds a window of entries and
the documents `pi.live` (the active run: partial answer, tool calls and their output, retry state)
and `pi.inbox` (queued messages). The page merges each view into a `ConversationTranscript`, which
keeps every entry it has seen. After a dropped stream the page asks for `?from=<entry id>`, so the
facet starts the window after the newest entry the page holds. "Load earlier" and gap filling read
`GET /api/projects/{id}/entries`, which the Supervisor relays to the facet's `entries` call.

**One serving facet name holds the session.** Pi Durable keeps its conversations, entries, tasks
and submissions in SQLite. That SQLite is the serving facet's own storage, under one facet name that
every generation serves under (`SERVING_FACET_NAME` in `src/supervisor/artifacts/facet-name.ts`). The
facet storage belongs to the Supervisor's Durable Object, so it survives a generation change and a
rollback, and the runtime gives one name one instance, so only one writer ever opens the session.
Activation and rollback abort the facet; the next call mounts the new generation's class over the
same storage, and Pi Durable resumes the interrupted work. The Supervisor never deletes the serving
facet. Startup-check candidates run under per-commit names and never open the session.

**Alternative.** Keeping the session in the Supervisor's own SQLite, reached from the facet through
a storage RPC adapter, was measured in production: every commit waited about 43 ms for the
Supervisor's durable write, which added about 395 ms at p50 and 750 ms at p95 to a one-tool turn;
facet-owned storage answered at about 146 ms p50. The adapter's one advantage is a session that
could outlive a Pi Durable schema change across a rollback, and the compatibility key below already
rules that rollback out.

**Every runnable generation speaks the Supervisor's facet compatibility.** The compatibility key,
`FACET_COMPATIBILITY` in `src/facet/runtime-contract.ts`, is `pi-durable@<version>/host-<N>`: the pinned Pi
Durable version, and the revision of the facet-to-Supervisor protocol. Bump `host-N` whenever that RPC contract changes in a way an older generation does not
satisfy. The startup check asks the candidate's `compatibility()` and fails the candidate unless it
equals the Supervisor's key. A generation built before the method existed cannot answer and fails
at mount. Preparation records the checked key on the generation, and activation and rollback refuse
with `facet-compatibility-mismatch` when it differs from the Supervisor's, or when none is recorded.
Submitting the generation's harness commit again re-runs the check. Without this, a rollback could
load code that reads the session with another schema, or code whose tool calls the Supervisor
refuses because it never reports its runs.

**The Supervisor keeps its authority.** Facets cannot set alarms (in production `setAlarm` throws and
leaves the facet unusable), so the generation relays each Pi Durable wake to the host's `arm`, and the
Supervisor's alarm attaches the facet again, which resumes the run. The Supervisor maps each project
to its current conversation in its own `project_conversations` table, so it answers the project list
without waking the facet. It hands a run a project capability through the host's `workspace`, ends
every capability when the run settles, and aborts a run that passes `PROJECT_RUN_DEADLINE_MS`
(`src/supervisor/conversations/`). Each run row stores which serving instance started it and, once
the owner cancels it or the deadline aborts it, how it is ending, so a restart does not forget a
cancel. A replaced instance's `running` and `arm` calls are refused before they reach the Supervisor.
A reset, or an owner activation or rollback, refuses with `run-active` while a run is active. A
disconnect refuses with `run-active` only while a run is active in that project.

**The generation reaches nothing else.** Its model provider calls only the model capability that `attach` passes, and its
`ExecutionEnv` runs file and command operations only through the project capability. The Worker
Loader starts it with `enable_weak_ref`, which `chord` needs. `FACET_RUNTIME`, beside the key in
`src/facet/runtime-contract.ts`, holds the loader's compatibility date and flags.

**Model errors.** Pi retries a model error only when its text matches Pi's own list
(`isRetryableAssistantError`), and Pi Durable cannot be told to extend that list. The route's own
failures therefore live in one table, `src/model-route-wire/failure.ts`, and a test asks Pi about
each text. The Supervisor not answering, the route not answering and a stream cut short are retried
(three times, after 2, 4 and 8 s); a reply the facet cannot read is not. Pi compacts a thread only
when the error text matches its context-overflow list (`isContextOverflow`), so the route refuses a
request over 1 MiB with Pi's own `request_too_large` wording. Pi budgets the context in estimated
tokens, and tool results full of control characters, such as reads of a binary file, can push a
request past 1 MiB below the token threshold; with any other wording every later run of that thread
fails the same way.

**Run endings.** Three rules keep a run's ending from being lost or mistaken.

1. The facet stores the runs of the last `running` report that the Supervisor took
   (`relay.reported`, in the facet's storage), and writes the runs it is about to send before it
   sends them. A new session that follows a lost report therefore starts from what the Supervisor
   knew, and its first report carries the failures of the runs that ended meanwhile. Otherwise a
   refused report leaves the run to settle `completed`, which could prove a generation that had
   faulted.
2. The owner's cancel first clears the conversation's run budgets and then aborts, and the deadline
   continues a run only while it has a budget, so a deadline abort that races a cancel cannot
   continue the cancelled run. A resend of a message the facet already holds leaves the budgets as
   they are.
3. The Supervisor stores a cancel that arrives before the facet's first `running` report for the
   conversation (table `conversation_cancels`), and the run that the next report starts begins as
   cancelled, so it settles `cancelled` and not `unanswered`.
