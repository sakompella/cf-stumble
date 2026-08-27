# Run one executor for the gate and for live turns

The validation gate and live operation run the candidate generation's own executor. Recorded and live model responses are interchangeable sources behind it; the gate does not drive a simpler runner built for testing. A gate that executes different code from production validates a surrogate, so every compatibility claim would be about the test harness rather than the agent that runs. That divergence would widen silently because nothing fails when it does. The gate runs whichever executor the candidate has, rather than one executor fixed for all generations. When a facet changes its loop or tools, the gate runs that change too rather than a separate older executor.

## Consequences

The scripted runner originally used by the gate was simpler and is the rejected alternative. Reversing this after a compatibility corpus exists invalidates every recorded case, because each case asserts effects from a specific executor.
