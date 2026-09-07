# Oracle summary

## Goal

Deploy an owner-only coding agent that streams useful work on connected GitHub projects and can activate or roll back a labeled harness commit without losing project files or the current Pi conversation.

## Architectural findings by leverage

1. Own the complete turn behind one server interface. Admission, streaming, thread saving, and relay credit are currently separate. Lease-aware storage exists, but public finish/abandon paths discard the lease ID. Browser success must follow durable save.
2. Implement the approved shared machine, not just a shared host name. Per-project host hashing, a global build host, and fixed `/project` addressing still encode the old layout. Preserve repository directories and measure container/build concurrency.
3. Make the labeled commit genuinely buildable from clean state. The oracle reproduced missing Pi `dist/index.js` in a clean archive. Existing paid evidence proves only R2 and Workers AI, not Computer build/load or the full capability path.
4. Finish Pi integration and delete the other turn loop. The real Agent exists, but the model route buffers output, facet frames omit tool-call/output detail, and instructions/compaction are not wired into the application turn.
5. Replace the two-placeholder catalog with connected GitHub projects. Access identity already works. Separate repository authorization, local gh credentials, and provisioning still need one owning module.
6. Delete generation request IDs, fingerprints, and the control journal under ADR-0030. Preserve epochs, commit labels, active-target no-ops, and rollback admission.
7. Keep useful adapters and protocol tests. Add narrow turn/output bounds and one R2 age rule. Do not expand recovery, invent another artifact identity, or flatten deep modules because they contain small files.

## Wave plan

| Wave | Tasks | Result |
| --- | --- | --- |
| 0 | T1 | Clean commit build and paid capability/build/load proof. |
| 1 | T2, T3, T4, T5 | Direct controls, shared workspace, model events, lease fencing. |
| 2 | T6, T7, T8 | GitHub connection, Pi session behavior, R2 age limit. |
| 3 | T9 | One authenticated saved streamed turn. |
| 4 | T10, T11 | Conversation page and independent workflow fault tests. |
| 5 | T12 | Exact-commit paid demo, evidence, deployment procedure, recording. |

Critical path is T1 -> T3 -> T6/T7 -> T9 -> T10/T11 -> T12.
Every task includes scope, acceptance criteria, dependencies, size, owner tier, and `pnpm verify`.
Paid failures stop dependent work. Product questions use explicit defaults for reversible work.

## Keep settled decisions

Keep Pi, Supervisor generation authority, commit-keyed loading, R2 as a rebuildable cache, Access verification, plain RPC values, one shared workspace, one current thread per project, and manual rollback. No human-approved ADR was disproved in this review. T1 must test ADR-0034's reproducibility assumption.

## Open owner questions

Q1 is preserved unchanged in `questions.md`.
Q2 asks whether one-time gh device authorization is acceptable.
Q3 asks whether cancelled turns retain completed partial conversation messages.
Q4 asks whether generation controls use a drawer or stay visible.
Q5 asks where the recording may be published and what it may show.
Q6 asks whether the current fixed Workers AI model satisfies the owner's provider preference.
Platform behavior and timing are experiments, not owner questions.

## Evidence and files

Reviewed HEAD is `d6ff2380487a60f410c568272635d99f30560d14`.
`pnpm verify` passed 93 files and 642 tests. See `verify-baseline.log`.
The separate clean-archive build exited 1. See `clean-build-baseline.log`.
Five Sonnet subsystem summaries were read and checked against targeted source reads.
No tracked repository files were modified. No paid deployment was run by the oracle.

Read `architecture-critique.md` for ranked findings and deletion tests.
Dispatch from `roadmap-v0.md`. Judge release completion against `goal.md`.
All files are in `/tmp/cf-stumble-v0/`.
