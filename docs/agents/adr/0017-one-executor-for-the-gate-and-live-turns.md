# Run one executor for the gate and for live turns

The validation gate and live operation run the candidate generation's own executor, with recorded and live model responses as two interchangeable sources behind it, rather than the gate driving a simpler purpose-built runner. A gate that executes different code from production validates a surrogate forever: every compatibility claim would be about the test harness rather than about the agent that actually runs, and the divergence would widen silently because nothing fails when it does. This binds the gate to whatever executor the candidate under test actually is, not to one executor implementation fixed for all generations — a facet that changes its own loop or tools carries that change into the gate path automatically, because the gate is never running a separate, older executor on its behalf.

## Consequences

The scripted runner the gate originally used was the genuine alternative, and it was simpler. Reversing this after a corpus exists invalidates every recorded case, because the cases assert effects produced by a specific executor.
