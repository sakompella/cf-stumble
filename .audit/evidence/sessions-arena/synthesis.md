# Session store arena, synthesis

Base: **candidate 1**. Cross-judge `gpt-5.6-sol` scored it 29, against 28 for candidate 3, 27 for candidate 4 and 25 for candidate 2. All four passed `pnpm verify`. Full scores with citations in `judgment.md`.

I had leaned candidate 3 and changed my mind on the judge's argument. Candidates 2, 3 and 4 expose a standalone `write` beside the turn slot, so any caller can save a document while another client holds the turn. The slot then guarantees nothing. Candidate 1 has no standalone write at all: a document is persisted only by `finishTurn(sessionId, expectedRevision, document)`, which saves, advances the revision and releases the slot in one transaction. Four Supervisor methods instead of five, and the invariant is structural.

All four converged on the same table, `session_id`, `document`, `revision`, `turn_active`, and on the ADR-0036 split of pure deciders from SQLite writes. Convergence on the data shape means the shape was not the hard part. The contract was.

## Grafted

- **From candidate 3, a storage-level stale-save test.** Candidate 1's equivalent test asserted the pure decision only, which is why the judge scored its stale-write criterion 4 rather than 5. The grafted test finishes a turn with a stale revision and then asserts the stored document is still the old one.
- **From the parent, a turn lease.** No candidate gave a turn a deadline, so a facet that died mid-turn left `turn_active` at 1 forever and bricked that session. Only the dead client could call `abandonTurn`. `relay_attempts` already bounds a relay with `deadline_at` rather than waiting on a caller that may never return, so this follows the house pattern. A turn now holds the session until `turn_deadline_at`, the next start after that takes the slot over, and finishing after the deadline is rejected as `turn-expired` rather than silently overwriting a newer turn.

## Rejected

- **Candidate 2's idempotent release.** `finishTurn` on a session with no active turn returns `{ ok: true, effect: "no-op" }`. It hides a caller bug. Candidate 1 rejects with `turn-not-active` and the caller learns something.
- **Candidate 2's JSON parsing in `row.ts`.** The document is meant to be opaque. Parsing it in the store contradicts that, and the judge marked it down on table shape for the same reason.
- **Candidate 4's revision check on abandon.** Abandon is the escape hatch after something went wrong, so requiring the caller to hold the current revision makes recovery harder exactly when the caller is confused.
- **Candidate 4's revision increment on turn admission.** The judge caught the consequence: retrying the original start reports a stale revision instead of a turn conflict, so a retry cannot tell a lost race from a lost update.
- **A `session_turns` history table, considered by candidate 3.** Nothing reads it in version 0.

## Verification

`pnpm verify` passes with 35 test files and 188 tests, up from 33 and 168. The new tests were checked against two mutations rather than trusted: dropping the deadline from the turn-holding check fails four tests, and multiplying the lease by 1000 fails four tests.
