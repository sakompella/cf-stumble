# Relay simplification

## Refactoring

1. Pin the behavior contract first. Run the how skill over the affected subsystem to learn the contract, then write a characterization test, snapshot, or equivalence harness that captures current behavior before any structure moves. The harness makes "refactor" a checkable claim. If the area has no coverage, write the pin before touching structure. Type check and lint are not a pin.
2. Name the structure the code is missing: a state machine over scattered booleans, a table or registry over spread-out branching, a typed model over repeated shape assumptions, a reducer over ad hoc mutations. Boring code stays when the shape is already clear and local; the reshape must delete branches or invalid states, not add indirection.
3. Name the target shape. State what the module layout, types, and call graph should be if built today. If the target crosses a function boundary, run the architect skill for parallel design exploration of the shape before the move.
4. Subtract before you add. Delete dead weight, collapse one-caller wrappers, drop redundant validators, and remove orphan references before introducing the new shape. The smallest change that reaches the target shape ships. A speculative cleanup that might help gets reverted, not left to ride.
5. Move in small behavior-preserving steps, each keeping the pin green. For API reshapes, migrate every caller and delete the old API in the same wave. No compatibility shims, no parallel old-and-new paths. Spot-check every rename against the actual files; renames silently miss usages in strings, prose, and back-references.
6. Prove behavior is unchanged on the real artifact, not "it compiles". For larger reshapes, run an equivalence check: a script that diffs old-vs-new outputs, a recorded baseline replayed against the new code, or a smoke run on the matching surface. Own the verification yourself; do not trust a delegate's looks-good summary.
7. Confirm the change earns its place. The success measure is reduced reader load: fewer layers between question and answer, less hidden state, fewer indirections without a second consumer. If the diff does not lower reader load somewhere, revert it.
8. Rebase into small ordered commits that tell the story. A subtraction commit, then the reshape, then any follow-on cleanup, so a single revert undoes one slice. Shape them so each behavior-preserving slice stays green before the next.

## Architect phases

1. Ground. Done. `relay_attempts` already contains the lifecycle, attribution, status, and terminal outcome. `relay_facts` duplicates it, and eligibility folds the duplicate record back into an attempt summary.
2. Sketch. Done. Four candidates and an independent cross-judge chose one attempt table, the existing `RelayAttempt` union and `relay-types.ts`, `RelayAttempts.all()`, and direct eligibility. Rejected adding header time, merging types into storage, renaming or deleting ADR-0031, and any compatibility shim.
3. Agree. Skip: the user requested simplification without a design checkpoint.
4. Implement. Done in `aedbd16`, with stale test wording corrected in `f43c78a`. One durable attempt table now owns relay state, eligibility, and recovery evidence.
5. Scrap. Skipped. Focused lifecycle and eligibility tests plus `pnpm verify` preserved the pinned behavior.

## Throughput checkpoint

- [x] Pin the current observable relay and eligibility behavior through public Supervisor methods.
- [x] Compare at least two designs for replacing the dual persistence model.
- [x] Delete the duplicate model and migrate all callers in one wave.
- [x] Run focused workerd tests, then `pnpm verify`; the reduced model preserved the pin.
