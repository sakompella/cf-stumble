# v0 review: next moves

Based on the supplied reviews of `7818f8d` and the hp work brief, not a fresh code or runtime verification.

## 1. Is the order right?

Mostly. T14 is already merged according to the hp update; verify that merge, then keep turn lifetime first and credit correctness next. Run the pinned x64 container preflight alongside those repairs: Linux can now test tool availability and clean builds locally, without claiming paid Cloudflare evidence or using unapproved accounts. Keep the real-Git test, browser harness, and model entrypoint test; retracting a broken browser command repairs documentation but does not satisfy UI acceptance. Add the missing saved-compaction → Supervisor reload → replacement-generation test, and prepare the criterion-mapped Q7 request now rather than after all six fixes.

## 2. Is the lifetime repair sufficient?

It is the correct ownership model, but an abort signal alone is not the safety guarantee. One admission must own the absolute deadline, generation/preparation snapshot, and cancellation through provisioning, start, streaming, and workspace operations; late starts must be disposed of. Before admitting replacement work, the host must establish that old mutating operations have stopped, including already-running shell processes, or prevent them from affecting the replacement workspace. Lease checks on new calls do not stop a command already executing: test that case and failed cancellation explicitly, and fail closed if termination cannot be established rather than introducing a general scheduler or rewriting the architecture.

## 3. Discipline or diff design?

Both: the circular fake is a testing discipline failure, while the undefined meaning of “the turn's diff” is a design failure. Define the contract before replacing tests: `git diff HEAD` describes tracked changes against HEAD, not necessarily this turn, and misses new files and edits committed during the turn. Put real Git behind the production execution adapter in a temporary-repository integration test, assert independently specified file changes and emitted frames, and include pre-existing dirt, new files, and a commit during the turn. Killing the `cat` mutation is a minimum check, not proof that the chosen diff semantics meet criterion 4; no new diff framework is needed.

## 4. Should v0 shrink?

Keep the functional and safety criteria: useful coding, saved conversation across generation changes, manual rollback, owner isolation, and durable files are the product, not optional hardening. Unanswered paid approval makes their evidence blocked; it does not justify deleting them or calling local container results deployed proof. Keep known-good policy expansion outside v0, but fix false credit in retained code; separate public publication in criterion 10 from private release acceptance pending owner approval, while retaining the recording and release artifacts. Do not add background turns, automatic recovery, or a broader cache policy to solve these findings.

**Highest-leverage action:** Make replacement-turn admission conditional on the old turn losing all ability to mutate the workspace, and prove it with an already-running write command that survives the initial cancellation request.
