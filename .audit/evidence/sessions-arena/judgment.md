# Session store arena judgment

I ran `pnpm verify` in all four worktrees. All four passed typecheck, format, lint, and tests.

## Score table

| Criterion | Candidate 1 | Candidate 2 | Candidate 3 | Candidate 4 |
|---|---:|---:|---:|---:|
| Session table shape | 5 (`candidate-1/src/supervisor/sessions/index.ts:27-34`) | 4 (`candidate-2/src/supervisor/sessions/store.ts:27-34`; parses JSON at `candidate-2/src/supervisor/sessions/row.ts:36-42`) | 5 (`candidate-3/src/supervisor/sessions/index.ts:45-52`) | 5 (`candidate-4/test/supervisor/sessions/sessions.test.ts:69-80`) |
| Stale write rejection | 4 (`candidate-1/src/supervisor/sessions/index.ts:68-94`; weak test at `candidate-1/test/supervisor/sessions/sessions.test.ts:19-42`) | 5 (`candidate-2/test/supervisor/sessions/store.test.ts:34-47`) | 5 (`candidate-3/test/supervisor/sessions/sessions.test.ts:37-50`) | 5 (`candidate-4/test/supervisor/sessions/sessions.test.ts:82-104`) |
| Turn admission | 5 (`candidate-1/test/supervisor/sessions/sessions.test.ts:45-104`) | 4 (`candidate-2/src/supervisor/sessions/store.ts:47-76`; coverage at `candidate-2/test/supervisor/sessions/store.test.ts:61-127`) | 4 (`candidate-3/src/supervisor/sessions/index.ts:60-80`; coverage at `candidate-3/test/supervisor/sessions/sessions.test.ts:52-120`) | 3 (`candidate-4/src/supervisor/sessions/decisions.ts:62-74`; test changes the second start's revision at `candidate-4/test/supervisor/sessions/sessions.test.ts:110-128`) |
| Boundary discipline | 5 (`candidate-1/src/supervisor/sessions/decisions.ts:18-77`; `candidate-1/src/supervisor/supervisor.ts:173-186`) | 5 (`candidate-2/src/supervisor/sessions/decisions.ts:24-55`; `candidate-2/src/supervisor/supervisor.ts:180-201`) | 5 (`candidate-3/src/supervisor/sessions/decisions.ts:22-50`; `candidate-3/src/supervisor/supervisor.ts:181-202`) | 5 (`candidate-4/src/supervisor/sessions/decisions.ts:29-102`; `candidate-4/src/supervisor/supervisor.ts:179-196`) |
| Gate | 5 (`candidate-1/src/supervisor/supervisor.ts:173-186`) | 5 (`candidate-2/src/supervisor/supervisor.ts:180-201`) | 5 (`candidate-3/src/supervisor/supervisor.ts:181-202`) | 5 (`candidate-4/src/supervisor/supervisor.ts:179-196`) |
| Reader load | 5 (`candidate-1/src/supervisor/supervisor.ts:173-186`; four RPCs) | 2 (`candidate-2/src/supervisor/sessions/index.ts:1-13`; extra wrapper, five RPCs at `candidate-2/src/supervisor/supervisor.ts:180-201`) | 4 (`candidate-3/src/supervisor/supervisor.ts:181-202`; five RPCs) | 4 (`candidate-4/src/supervisor/supervisor.ts:179-196`; five RPCs, but only one test file) |
| **Total** | **29** | **25** | **28** | **27** |

## Recommended base

Ship candidate 1. Its four-method contract matches one buffered coding turn. `startTurn` checks the caller's document revision but does not advance it. `finishTurn` saves the new document, advances the revision, and frees the slot in one transaction (`candidate-1/src/supervisor/sessions/index.ts:41-95`). `abandonTurn` frees the slot without changing the last durable document or revision (`candidate-1/src/supervisor/sessions/index.ts:97-115`). After a crash mid-turn, recovery can abandon the stuck slot and retry from the unchanged document.

The design fork is not close. Turn admission and the expected document revision should be coupled. A write should require the admitted turn. Candidate 2 and 3 let any caller write while another turn owns the slot (`candidate-2/src/supervisor/sessions/store.ts:37-76`; `candidate-3/src/supervisor/sessions/index.ts:60-80`). Candidate 4 revision-checks admission, but starting the turn itself increments the revision. Repeating the original start therefore reports stale revision rather than conflict (`candidate-4/src/supervisor/sessions/decisions.ts:62-74`).

Candidate 1 loses one point because its “stale write” workerd test makes a stale `startSessionTurn` call, not a stale `finishSessionTurn` carrying a replacement document (`candidate-1/test/supervisor/sessions/sessions.test.ts:19-42`). The implementation rejects stale finishes before SQL, but the required integration proof is missing (`candidate-1/src/supervisor/sessions/index.ts:73-84`).

## Grafts from the losing candidates

- From candidate 2, graft the explicit Durable Object eviction check after generation activation (`candidate-2/test/supervisor/sessions/store.test.ts:130-149`).
- From candidate 3, graft its real stale-save assertion, adapted to candidate 1's `finishSessionTurn` API (`candidate-3/test/supervisor/sessions/sessions.test.ts:37-50`).
- From candidate 4, graft the exact `PRAGMA table_info(sessions)` schema test (`candidate-4/test/supervisor/sessions/sessions.test.ts:69-80`).
