# First implementation plan

> **Superseded for v0:** Handoff decisions 6 and 7 remove R2 cache, recovery, promotion rules, and relay records from version 0.

**Status: retained for implementation history and local evidence. `feature-map.md` now defines the version 0 completion scope and cut line.** The locally provable parts of steps 1, 2, 4, 5 and 6 are built and tested against local workerd. Nothing has been deployed. This is a working implementation sketch, not the product definition. `overview.md` and the current ADRs take precedence. Normal Supervisor traffic currently uses the active generation's retained module map rather than a constructor-bound fixture.

What existed at the end of this plan: an interim local module-map store under the labeled harness commit, supervisor-owned generation state in Durable Object SQLite, a bounded ordinary-request startup check (ADR-0029), and epoch-checked requests with a request-deduplication journal. ADR-0030 replaces the request journal with direct generation commands. Handoff decisions 6 and 7 later cut R2 cache, relay records, promotion rules, and recovery behavior from version 0.

The module map now stays in Supervisor SQLite. The main remaining gap is authenticated control transport. Nothing authenticates a principal yet, because the transport that carries a request from a browser or from the main facet remains open.

Start with local workerd tests, then use the paid account for behavior that local tests cannot prove. Build one small end-to-end path before broadening the harness.

## First vertical path

1. **Test the supervisor boundary.** Run the primary Supervisor Durable Object with a Worker Loader and one Dynamic Worker facet built from a small executable fixture. Use the labeled harness commit ID as the fixture's Worker Loader name, as ADR-0027 requires. Test ordinary `fetch` forwarding because local prototypes show that it works, while keeping the supervisor-to-facet interface replaceable until the project chooses it.

2. **Test startup.** Load the first mutable Pi-fork generation, force a cold start, and run an ordinary interaction through the proposed boundary. Record what demonstrates that the generation is ready rather than turning the check into a permanent custom facet protocol.

3. **Test project access.** Use the pinned Computer pair from ADR-0026. Confirm the Worker-shell and container capabilities, then compare at least a separate project workspace, a separate harness project, and a temporary combined view. This spike preceded ADR-0038, which selected one shared workspace with a separate directory and Git history for each repository.

4. **Exercise generation requests.** Submit one harness revision as a generation candidate, then request activation of a named existing generation. The supervisor must allocate identities, validate requests, perform or reject state changes, and record the results. The requester must not be able to write protected state directly.

5. **Run one real conversation.** After the spike selects a model egress path, run a real coding turn against a cloned project repository. Persist the conversation route and generation number. Do not count a response as a completed real turn from its HTTP status alone. A response can start successfully and fail while streaming.

6. **Keep manual rollback.** A failed candidate leaves the active generation serving. An owner may return to an earlier generation that ran before. Do not add automatic repair or promotion behavior.

7. **Add the first UI.** Keep it to the conversation, current generation, and checked activation or rollback requests. Broader administration and development interfaces can wait.

## Completion evidence

The vertical path is complete when a paid deployment proves all of the following:

- Generation 0 is a mutable main facet, while the recovery harness remains immutable and outside generation selection.
- Normal traffic and the startup check exercise the same proposed supervisor-to-facet boundary.
- A specific harness commit can receive a generation label and become a generation candidate without granting the requester direct recovery authority.
- The main harness can work with durable Computer files while project and harness Git histories remain separate.
- A failed candidate leaves the active generation serving.
- Manual rollback loads the stored module map for an earlier generation that ran before.

## Open choices before implementation commits to them

ADRs 0028 through 0030 settle the startup check, artifact shape, and direct generation requests. Each record states what it does not settle. The rest of this list stands.

- The supervisor-to-facet interface and the startup check that fits it.
- What counts as a completed real turn, including 4xx and 5xx responses and streams. The Supervisor must not treat a successful HTTP status as enough evidence because a stream can fail after its headers arrive.
- The model egress or gateway choice.
- HTTP, SSE, or WebSocket for the UI transport.
- How Computer builds executable Worker modules from the labeled harness commit and stores the resulting map in Supervisor SQLite.

Do not settle these by implication in an implementation. The paid-account spike should produce evidence for each choice, and the resulting decision should be recorded before the dependent path grows.

## Excluded from this plan

This path does not add replay gates, attestations, canaries, quarantine, garbage collection, migrations, a custom Git codec, or broad administration and development interfaces.
