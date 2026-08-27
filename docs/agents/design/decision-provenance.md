# Decision provenance

This record distinguishes human decisions from agent decisions. A decision no human ratified needs
more scrutiny than one a human argued over. When something looks odd, this file says whether to
trust it or investigate it.

It distinguishes human from agent decisions. The role of a particular agent, whether reviewer,
researcher, or implementer, does not matter here and was never recorded consistently.

## The human's decisions

These set direction. Everything else is downstream of them.

**The architecture itself.** Generations modelled on NixOS, a supervisor Durable Object the agent
cannot modify, agent code in an isolated facet, storage on the git object model, a validation gate
before promotion, generation 0 pinned with a reset that bypasses agent code. This was modelled on [Autolith](https://github.com/lambda-symbolics/autolith)'s split between a
broadly mutable active image, a small stable launcher, and a pristine recovery image (see
`docs/agents/design/prior-art.md`). The brief said the facet's model loop, tool registry, prompts,
skills, policies, modules, and work environment should evolve, while the supervisor materializes,
validates, and recovers. Agents implemented that direction; they did not invent it.

**The generation remodel.** Commits became ordinary commits; a generation became one _attempted
facet materialization_, numbered by a monotonic counter. This is the largest design change the
project has undergone, and it fixed a genuine identity bug — lineage depth is not an identity, and
rolling back then branching produced two distinct generations both claiming number 1.

**Adopt `@cloudflare/computer`, home-roll as little as possible, dependencies are not a concern.**
This reversed a long-running agent argument for keeping a hand-written git object codec.

**One runtime.** The whole test suite runs in workerd. A Node test does not provide evidence about
the deployed runtime.

**Replace the `git` binary oracle** with isomorphic-git, which is what made the single-runtime move
possible at all, since a subprocess cannot run in workerd.

**Keep git**, when the agent argued that the simplest solution was to drop it entirely for two
plain SQL tables. Recorded as ADR-0018.

**Workers Paid is acceptable**, which unblocked the production shell and the facet loader.

**Network egress is not the main risk.** A correct deprioritisation; the agent had overweighted
exfiltration relative to the containment that actually matters, which is the agent being unable to
reach the supervisor and disable its own rollback. Recorded as ADR-0019.

**Adopt the `anti-slop` lint rules.** **Nothing reaches GitHub without approval.** And every
instruction about process: work overnight in slices, parallelise, commit small and often, use
subagents, find prior art.

## The agents' decisions

Structural and local. None of these changed what the project is.

**Decomposition and integration.** The slice breakdown and ordering, the shared type seams that let
agents work in parallel without inventing divergent contracts, the merge conflict resolutions, and
the adoption ratchet that let a lint rule set land without the build ever going red.

**Correctness catches during review.** The most valuable agent contribution in the project:

- **The validation gate was circular.** Replaying recorded model responses cannot validate a prompt
  change, because the tape is an output of the old prompt — so a prompt-only candidate replays to
  identical behaviour and passes vacuously. The gate would have rubber-stamped exactly what it
  exists to police. Caught in review before implementation.
- **Attestations must bind** candidate, baseline, corpus version and gate version, or "validated"
  degrades to "validated at some point, against something."
- **The ratchet needs mandatory canaries**, or an empty or all-failing corpus makes "nothing
  regressed" vacuously true.
- **Facet isolation had to be proven first, not last.** It is the claim everything rests on.
- **Materialization and activation are different things** and cannot share one status field.
- **Garbage collection should not be built**, because a root-discovery bug deletes what rollback
  depends on and there is no storage pressure to justify the risk.

**Bugs found and fixed without being asked.** An unbounded retry loop in reset that would hang a
Durable Object rather than fail; two independently written escape hatches that would have drifted;
canary identity sourced from the mutable corpus, letting a candidate delete the canary that caught
its own regression; a test credential in a gitignored file, so eleven tests passed only for whoever
created them; a 2 MB storage ceiling that threw a raw SQLite error.

**Local implementation calls**, ratified rather than directed: rollback requires no attestation so
recovery survives validation being unavailable; `edit` must match exactly once, with no-match and
ambiguous-match as distinct typed failures; canaries pinned outside the corpus; the
`prompt.md` / `policy.md` manifest convention.

## Where the human corrected the agent

These matter more than the rest of this file, because they are the cases where the agent was
confidently wrong and the documentation would have preserved the error.

**The four-action limit came from a derivative prompt, not the product.** An overnight build prompt
based on a historical local export constrained the agent to four action primitives forever. The
constraint entered the codebase and documentation as though it expressed human intent. The human
brief instead followed Autolith: a broadly mutable active harness and a small stable recovery
authority (see `docs/agents/design/prior-art.md`). Containment protects the supervisor's
independent recovery; it does not impose a permanent four-tool ceiling on the facet. The export
has no role labels and begins mid-conversation, so it cannot settle intent. This correction rests
on primary Autolith sources, not a closer reading of that export.

**The git codec justification was false.** Isomorphic-git exports `writeTree` and `writeCommit`,
and both work on an in-memory filesystem. Asking "are you sure?" found the error after it had
already entered the decision record. Two of the three replacement arguments also failed: the
oracle argument was circular, and the dedup argument conflated content addressing with git's byte
format.

**Jargon standing in for explanation.** "What do you mean git codec?" and "you haven't discussed
this" both caught explanations that assumed context never provided. The lineage cycle guard had
been referenced three layers deep without ever being introduced.

**Over-engineering the storage argument.** The agent defended a bespoke content-addressed invariant
that turned out to be protecting a premise that had already collapsed — Cloudflare Artifacts was
supposed to replace the store, and Artifacts is named git repositories over the git protocol, not
caller-hash-addressed storage.

## Where the agent pushed back and the human accepted

**"Tags" became "registry."** Git tags are refs; refs are mutable named pointers, are not
content-addressed, and we have no ref store. What was wanted was a registry, and naming it
correctly mattered.

**"KV or SQLite" became SQLite only.** KV is eventually consistent and outside the Durable Object's
transaction domain, and promotion updates four things together. Splitting any of them into KV makes
promotion non-atomic, which is the one property the safety argument depends on.

## How to read the rest of the documentation

Decisions in the first section were argued over by a human who repeatedly caught errors, and are
the most reliable. Decisions in the second section are agent-made; the review catches have been
independently verified with tests, but the local implementation calls have had less scrutiny and
are the most likely place for something to be quietly wrong.

`docs/agents/design/design-history.md` carries the reasoning, including the reasoning that failed.
`docs/agents/design/review-findings.md` records what a green test suite does not prove. Neither has been sanded
into a story where every decision was correct the first time, because several were not.
