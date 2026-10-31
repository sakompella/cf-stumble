# Run the agent loop on Pi Durable with Supervisor-owned storage

> **Review:** Agent-only

The main harness runs its agent loop on Pi Durable (`@earendil-works/pi-durable`, with `pi-ai` and
`chord`), pinned to one exact version. Pi Durable replaces the vendored Pi core, the Supervisor's
thread store, its turn leases and the turn stream the browser held open. A run now outlives the
browser: the browser sends a message, the generation works on it in the background, and the
browser watches the conversation's events.

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
`FACET_COMPATIBILITY` in `src/facet-compatibility.ts`, is `pi-durable@<version>/host-<N>`: the pinned Pi
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
(`src/supervisor/conversations/`). A reset or a disconnect refuses with `run-active` while a run is
active.

**The generation reaches nothing else.** Its model provider calls only the `MODEL` binding, and its
`ExecutionEnv` runs file and command operations only through the project capability. The Worker
Loader starts it with `enable_weak_ref`, which `chord` needs.

The harness no longer shows the repository's diff after a turn; that was a generation-0 frame with no
Pi Durable equivalent.
