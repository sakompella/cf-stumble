# Run the agent loop on Pi Durable with Supervisor-owned storage

> **Review:** Agent-only

The main harness runs its agent loop on Pi Durable (`@earendil-works/pi-durable`, with `pi-ai` and
`chord`), pinned to one exact version. Pi Durable replaces the vendored Pi core, the Supervisor's
thread store, its turn leases and the turn stream the browser held open. A run now outlives the
browser: the browser sends a message, the generation works on it in the background, and the
browser watches the conversation.

**The page watches Pi Durable's committed view.** The facet streams `conversation.watch()`, Pi
Durable 1.5.0's committed conversation view, instead of the event stream of 1.4.0 (`watchEvents`,
removed in 1.5.0). The stream is JSON lines. The first line is `[["r", view]]`, a replace of the whole
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

We first kept the session in the Supervisor's own SQLite and reached it from the facet through a
storage RPC adapter. In production every commit then waited about 43 ms for the Supervisor's durable
write, which added about 395 ms at p50 and 750 ms at p95 to a one-tool turn; facet-owned storage
answered at about 146 ms p50. The adapter's one advantage was a session that could outlive a Pi
Durable schema change across a rollback, and the compatibility key below already rules that rollback out.

**Every runnable generation speaks the Supervisor's facet compatibility.** The compatibility key,
`FACET_COMPATIBILITY` in `src/facet/runtime-contract.ts`, is `pi-durable@<version>/host-<N>`: the pinned Pi
Durable version, and the revision of the facet-to-Supervisor protocol (`host-2` added the `running`
call). Bump `host-N` whenever that RPC contract changes in a way an older generation does not
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
A reset, a disconnect, or an owner activation or rollback refuses with `run-active` while a run is
active.

**The generation reaches nothing else.** Its model provider calls only the `MODEL` binding, and its
`ExecutionEnv` runs file and command operations only through the project capability. The Worker
Loader starts it with `enable_weak_ref`, which `chord` needs. `FACET_RUNTIME`, beside the key in
`src/facet/runtime-contract.ts`, holds the loader's compatibility date and flags.

The harness no longer shows the repository's diff after a turn; that was a generation-0 frame with no
Pi Durable equivalent.
