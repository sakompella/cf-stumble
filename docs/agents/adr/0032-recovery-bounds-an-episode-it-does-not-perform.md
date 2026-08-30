# Bound a recovery episode the Supervisor does not itself perform

> **Review:** Agent-only

A failure event opens one recovery episode, deduplicated by the failure event's own identifier so the same failure arriving twice does not start a second episode. The episode snapshots its policy, so a later policy change cannot rewrite the bounds an episode already running is held to.

The episode first picks a fallback: the most recently labeled generation, other than the one that failed, whose retained evidence qualifies it under ADR-0031. When no generation qualifies, the episode is blocked and says so, and nothing is routed anywhere. Falling back to Generation 0 because it happens to exist, or to a null-like sentinel, would route traffic to code no evidence supports.

The Supervisor bounds repair rather than performing it. ADR-0024 keeps mutable harness code in the facet and the recovery harness immutable, and materialising a repaired generation needs a model call this project cannot make yet. So a repair attempt is a keyed operation the Supervisor opens, bounds and records, whose outcome is reported back to it. The key names the episode, the kind and the attempt number, so a crash mid-operation replays the same key instead of issuing a second effect under a new one, and an operation past its deadline is marked as needing reconciliation while keeping its key rather than being silently retried. Exhausting the repair attempts, or the episode's total budget, ends the episode with the fallback retained and names which bound was hit.

Every episode leaves a durable recovery report carrying the failure event, the failed generation, the fallback, the snapshotted policy, the attempts used, the phase, the result and the errors seen.

Two clocks stay separate, and conflating them was a real defect this work found and fixed. The epoch versions protected state for ADR-0030's staleness check and moves on every protected change. The activation identifier moves only when a generation becomes active, and it is what an evidence era is keyed by. While one counter served both, labeling an unrelated commit ended the running generation's evidence era and discarded its accumulated credit.

Time is a parameter throughout, because Workers pins `Date.now()` across a handler's I/O interval and a test cannot advance time by waiting. Nothing here is scheduled: no Durable Object alarm resumes an episode, because alarm survival across hibernation needs paid-runtime evidence this project does not have.
