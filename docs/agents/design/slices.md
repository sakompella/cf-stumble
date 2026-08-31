# First implementation plan

**Status: the locally provable parts of steps 1, 2, 4, 5 and 6 are built and tested against local workerd. Nothing has been deployed.** This is a working implementation sketch, not the product definition. `overview.md` and the current ADRs take precedence. Normal Supervisor traffic now uses the active generation's retained module map rather than a constructor-bound fixture.

What exists: a module-map artifact retained under the labeled harness commit and loaded after activation or Durable Object eviction (ADR-0028), supervisor-owned generation state in Durable Object SQLite, a bounded ordinary-request startup check (ADR-0029), epoch-checked and journaled generation requests (ADR-0030), a relay that records one attempt for each turn and derives known-good eligibility from terminal outcomes (ADR-0031), and a bounded recovery episode that picks an evidence-backed fallback (ADR-0032).

The main remaining gap is authenticated control transport. Nothing authenticates a principal yet, because the transport that carries a request from a browser or from the main facet remains open. Artifact production and long-term retention are also open. The Supervisor currently retains local module maps indefinitely.

Start with local workerd tests, then use the paid account for behavior that local tests cannot prove. Build one small end-to-end path before broadening the harness.

## First vertical path

1. **Test the supervisor boundary.** Run the primary Supervisor Durable Object with a Worker Loader and one Dynamic Worker facet built from a small executable fixture. Use the labeled harness commit ID as the fixture's Worker Loader name, as ADR-0027 requires. Test ordinary `fetch` forwarding because local prototypes show that it works, while keeping the supervisor-to-facet interface replaceable until the project chooses it.

2. **Test startup.** Load the first mutable Pi-fork generation, force a cold start, and run an ordinary interaction through the proposed boundary. Record what demonstrates that the generation is ready rather than turning the check into a permanent custom facet protocol.

3. **Test project access.** Use the pinned Computer pair from ADR-0026. Confirm the Worker-shell and container capabilities, then compare at least a separate project workspace, a separate harness project, and a temporary combined view. Choose a filesystem layout only after the model can complete a project task and a harness-change task without mixing their Git histories.

4. **Exercise generation requests.** Submit one harness revision as a generation candidate, then request activation of a named existing generation. The supervisor must allocate identities, validate requests, perform or reject state changes, and record the results. The requester must not be able to write protected state directly.

5. **Run one real conversation.** After the spike selects a model egress path, run a real coding turn against a cloned project repository. Persist the conversation route, generation number, and probation count, then exercise the selected UI transport through a disconnect or retry case before relying on it. Do not count a response as a completed real turn from its HTTP status alone: a response can start successfully and fail while streaming. Record what the supervisor observes when a response stream completes, fails, or remains unresolved after a client disconnect, then choose the real-turn rule and its bound before probation depends on it.

6. **Establish recovery.** Define a small set of external failures for the first recovery loop, trigger one in the vertical path, and validate the user-controlled `AGENTS.md` and recovery instructions before use. The recovery harness may select a previously successful generation or materialize a repair generation; after the chosen bound, it must return to the last known-good generation and record a recovery report.

7. **Add the first UI.** Keep it to the conversation, current generation and reliability evidence, recovery reports, and checked activation or rollback requests. Broader administration and development interfaces can wait.

## Completion evidence

The vertical path is complete when a paid deployment proves all of the following:

- Generation 0 is a mutable main facet, while the recovery harness remains immutable and outside generation selection.
- Normal traffic and the startup check exercise the same proposed supervisor-to-facet boundary.
- A specific harness commit can receive a generation label and become a generation candidate without granting the requester direct recovery authority.
- The main harness can work with durable Computer files while project and harness Git histories remain separate.
- A generation can gather evidence toward becoming known good without hard-coding an arbitrary turn threshold.
- A defined external failure produces a recovery report and returns to a known-good generation after the chosen repair bound.

## Open choices before implementation commits to them

ADRs 0028 through 0032 settle the startup check, the artifact shape, the request checks, the relay-attempt policy and the recovery bounds. Each of those records what it does not settle. The rest of this list stands.

- The supervisor-to-facet interface and the startup check that fits it.
- The filesystem layout for projects, harness source, sessions, and accumulated context.
- What counts as a completed real turn, including 4xx and 5xx responses, streams, and disconnects. The supervisor must not treat a successful HTTP status as enough evidence: a stream can fail after its headers arrive, and a client disconnect can leave a forwarded response unresolved. The spike must measure those cases before it chooses a completion rule or a bound for an abandoned forward.
- The model egress or gateway choice.
- HTTP, SSE, or WebSocket for the UI transport.
- Repair count and operation timeouts.
- How executable Worker modules are produced, bounded in storage, and eventually deleted. ADR-0027 selects the labeled harness commit ID as the Worker Loader identity, and ADR-0028 retains local module maps under that identity.

Do not settle these by implication in an implementation. The paid-account spike should produce evidence for each choice, and the resulting decision should be recorded before the dependent path grows.

## Excluded from this plan

This path does not add replay gates, attestations, canaries, quarantine, garbage collection, migrations, a custom Git codec, or broad administration and development interfaces.
