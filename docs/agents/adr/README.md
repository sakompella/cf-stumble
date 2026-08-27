# Architecture decisions

One decision per file, in a paragraph. Superseded decisions keep their file and say what replaced
them, so a reader who follows an old reference lands somewhere that explains itself rather than on
a 404.

This index exists so that "read the ADRs touching your area" is a lookup rather than sixteen file
opens. Grouped by area; a decision that spans two areas is listed under the one that owns it.
`test/docs/adr-index.test.ts` fails if a file here is missing from the list below.

## Generations and activation

- **[ADR-0002](0002-generations-are-materialization-attempts.md)** — a generation is one numbered
  attempt to materialize a commit, not the commit itself. Numbers never repeat, materialization is
  immutable, activation is an append-only ledger, and a turn pins its generation at start.
- **[ADR-0003](0003-supervisor-sqlite-controls-activation.md)** — the registry, live pointer,
  ledger, validation records, corpus and context all live in supervisor SQLite, and promotion moves
  them in one transaction with a compare-and-swap. Nothing outside that transaction decides what is
  live.
- **[ADR-0007](0007-prioritize-recovery-over-reclamation.md)** — generation 0 is pinned, rollback
  needs no fresh attestation, and nothing is garbage collected until a collector can prove its
  roots.
- **[ADR-0013](0013-migrate-facet-state-lazily.md)** — facet state migrates on first read rather
  than at promotion, which keeps promotion an atomic pointer switch.
- **[ADR-0001](0001-commits-define-generations.md)** — _superseded by ADR-0002._ Commits were
  generations, numbered by DAG depth. Depth is not an identity.

## Agent isolation

- **[ADR-0024](0024-facet-owns-the-evolvable-harness.md)** — the facet owns its model loop, tools,
  prompts, policies, modules, and work environment as ordinary, evolvable work; `read`, `write`,
  `edit`, `bash` were a bootstrap action space, not a ceiling. Capability breadth is judged by
  whether it reaches supervisor recovery authority directly, not by counting tools.
- **[ADR-0019](0019-contain-against-the-supervisor-before-egress.md)** — the threat being contained
  is the agent reaching the supervisor and disabling its own rollback. Exfiltration is ranked second,
  deliberately, and that ranking is what makes the rest of the isolation design coherent — and it is
  the reason a broad facet workspace isn't itself a containment concession.

## The validation gate

- **[ADR-0005](0005-use-replay-as-a-compatibility-ratchet.md)** — replay measures compatibility
  against the actual candidate facet at the protocol version the tape was recorded under, not prompt
  quality and not a frozen surrogate. Regressions from the live generation block promotion, and
  supervisor-pinned canaries must pass outright.
- **[ADR-0006](0006-supervisor-produces-promotion-evidence.md)** — the supervisor runs the gate and
  keeps the attestation; a caller cannot submit one. Corpus and gate versions are content-derived
  hashes.
- **[ADR-0014](0014-replay-cases-assert-observable-effects.md)** — a case asserts tool calls and
  workspace state rather than text, pins every source of variation, and reports `INCONCLUSIVE` for
  harness failure so the ratchet is never fed noise.
- **[ADR-0017](0017-one-executor-for-the-gate-and-live-turns.md)** — the gate and live turns run
  whatever executor the candidate generation actually is, behind two response sources, so a facet
  that changes its own loop or tools carries that change into the gate automatically.

## Git storage

- **[ADR-0018](0018-keep-git-as-the-storage-model.md)** — authored history is real Git objects, not
  two SQL tables. The others argue how to hold Git objects; this is the decision to hold them at all.
- **[ADR-0009](0009-store-git-objects-directly.md)** — Git's uncompressed framed bytes go straight
  into a content-addressed store rather than giving isomorphic-git a filesystem. Carries the case
  against the hand-written codec and the evidence behind the retraction.
- **[ADR-0011](0011-sha1-for-oracle-testability.md)** — SHA-1 is chosen so an independent
  implementation can check every encoding. It is not a security claim.

## The agent definition

- **[ADR-0012](0012-config-is-a-typed-record-not-generated-code.md)** — config is a validated,
  versioned, typed record in the manifest tree. No code generation stands between a validated
  generation and a running one.

## How the code is written and verified

- **[ADR-0008](0008-test-in-workerd-only.md)** — one test and typecheck runtime, workerd, because
  the Node path masked Worker-specific typing errors.
- **[ADR-0015](0015-brand-with-a-type-predicate.md)** — branded values come from a type predicate,
  never an `as` assertion, so the brand cannot lie about having been checked.
- **[ADR-0016](0016-parse-at-the-boundary-without-a-schema-library.md)** — untrusted input is
  narrowed once by hand at the boundary. No schema library.

## How this documentation works

- **[ADR-0022](0022-one-decision-register-kept-indexed.md)** — this directory is the only register
  of resolved positions, and a test fails when the index above stops being complete.
- **[ADR-0023](0023-agent-generated-docs-live-under-docs-agents.md)** — everything agent-generated
  lives under `docs/agents/`, which overrides where the engineering skills expect to find the
  glossary and the ADRs.

## Adding one

Take the next number, write a paragraph, and add a line here under the area it belongs to. Add a
`Status:` frontmatter field only when a decision is proposed or has been superseded; most ADRs
never need one.
