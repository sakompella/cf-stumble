# Poll the shim's disk walk every five seconds

> **Review:** Agent-only

The workspace image sets `COMPUTERD_POLL_MS=5000`, so computerd's userspace shim walks `/workspace`
for background changes every five seconds instead of every 250 ms. The walk patch from ADR-0042
adds the variable (one positive integer; unset keeps the upstream 250 ms). This changes one part
of ADR-0042's account of the shim: it no longer walks the tree every 250 ms. The rest of that
record stands.

**Why.** The walk is a full `lstat` of every entry outside `node_modules`, and it runs whether or
not anything changed. Measured on staging with no requests, computerd used about 0.4% of a vCPU
with one file, 0.40 vCPU with 4,040 files, and 1.0 vCPU with 10,102 files: about 0.1 vCPU per
1,000 entries, and nothing when the same files sat under an ignored segment. Production's idle
0.35 to 0.5 vCPU fits about 4,000 entries. At five seconds the same walk costs a twentieth of that.

**Why sync does not need the 250 ms poll.** At the pinned Computer commit,
`packages/computerd/src/cli/computerd.ts:675-676` wires the sync RPC with
`afterApply: () => shim.flush()` and `beforeFetch: () => shim.reconcileNow()`. A pull reconciles
the disk first, and a push flushes before it returns, so every Host operation sees the disk it
expects. The poll only moves a change made by a background process into the container's store
sooner. With a five-second poll such a change reaches the store up to five seconds later, and an
operation that pulls first still sees it at once.

**Alternatives.** Keep 250 ms and accept the idle cost: simple, but an idle container costs
vCPU time that grows with every cloned project. Disable the poll (a very large value): a
background writer's edit would reach the store only on the next pull, which is correct but gives
no safety margin. Five seconds keeps a bounded delay with a twentieth of the cost.
