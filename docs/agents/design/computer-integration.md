# Computer adoption decision

The facet's agent workspace uses `@cloudflare/computer@0.2.1` for its durable filesystem, ordinary Git workflow, and runtime, starting on the Worker-shell backend. ADR-0026 records the decision. The package version must stay exactly pinned; it supplies facet-owned mutable state without granting supervisor recovery authority.

This document was checked against npm and GitHub at the time of the decision. npm's `latest` tag is `0.2.1`; the `main` branch at `de87919a4fd37242e960e13b7b3ba802d1eef0a0` also declares `0.2.1`. The package remains preview software, so an upgrade needs a fresh review of its package, source, issue tracker, and Cloudflare documentation.

## Start on Worker-shell

Worker-shell is just-bash over a virtual filesystem with roughly 77 core utilities. It has no OS processes, compiler, or `npm install`. That is sufficient for the first working loop: the facet edits its own harness and submits a candidate, while Worker Loader accepts its JavaScript artifact.

The supervisor validates the candidate by replaying it against the compatibility corpus. The facet therefore does not need a test runner to prove its work, and any self-run test result would improve candidate quality at most; it cannot become gate evidence because the candidate's self-report is not trusted. Worker-shell adds no container awake charge, image or credential surface, or cold start.

## Container upgrade path

Move to the container backend when the facet needs to run a compiler, install packages, or execute a real test runner in its own agent workspace. This is a judgement about the harness's needs, not a milestone. The container backend is a real Linux process environment running `computerd`; standard-2 costs about $0.129 per hour while awake, cold-starts in roughly 1–3 seconds, and carries a larger credential and image surface.

As checked for this decision, [#114](https://github.com/cloudflare/computer/issues/114) remains open. It reports that deployed container WebSocket upgrades never complete, so deferring a container dependency avoids relying on an unresolved deployment problem. Both backends use the Computer API, so changing backends does not change the API the facet codes against.

## Authoring and loading

The facet authors and emits plain JavaScript. Worker Loader receives JavaScript regardless of backend, and Worker-shell has no compiler. If the facet later moves to the container backend, TypeScript becomes possible and the authoring-language decision can be revisited with that backend change.

`loadAgent` (`src/agent/loader.ts:88`) currently passes one `agent.js` module despite Worker Loader accepting a module map and a stored generation being able to contain many modules. Supporting multi-module or vendored output needs that small code change.

A compiler run in the agent workspace after a backend change is a self-check that improves candidate quality; it is not evidence for the validation gate. The supervisor still runs the candidate to produce validation evidence. Faking a self-check only leaves the facet with a candidate that fails replay.

## The open submission boundary

Candidate submission remains open: we have not designed a sanctioned path that hands the supervisor immutable candidate material without giving the facet a write path into supervisor recovery records.

The supervisor must obtain and inspect candidate bytes itself before allocating a generation, materializing it, and deciding whether it can become live. A submission capability may propose material but must not mutate the generation registry, materialization records, validation evidence, live pointer, rollback, or genesis reset. A remote or RPC transport alone does not establish immutability, authentication, or independent byte verification. Source migration waits for this boundary's design.

## Egress and containment

Computer's `git clone`, `fetch`, and `push` execute host-side. A Computer Workspace with a real Git remote can therefore reach the network even when the Worker's `globalOutbound: null` blocks ambient `fetch` and `connect`. The remote is a passed capability, and ADR-0019 requires it to be reviewed as an egress path in its own right.

This does not grant supervisor recovery authority. ADR-0019 ranks containment against the supervisor first and egress second, but a facet-to-supervisor binding must still never expose the supervisor's registry, validation evidence, live pointer, rollback, or genesis reset.

## Checked issue state

All six cited GitHub items remain open:

- [#68](https://github.com/cloudflare/computer/issues/68), reachable garbage collection for orphaned blobs and manifests.
- [#67](https://github.com/cloudflare/computer/issues/67), pruning acknowledged `vfs_changes` tombstones.
- [#105](https://github.com/cloudflare/computer/issues/105), undocumented `enable_ctx_exports` required by Worker-shell.
- [#106](https://github.com/cloudflare/computer/issues/106), missing published sqlite shell content.
- [#112](https://github.com/cloudflare/computer/pull/112), the `Version Packages` pull request.
- [#114](https://github.com/cloudflare/computer/issues/114), deployed container WebSocket upgrades that never complete.

None of these items has closed. In particular, #112 remains an open pull request and its unreleased changes do not make `0.3.0` a published package version. #114 remains open and supports starting on Worker-shell rather than relying on deployed containers.

## Current implementation boundary

This decision does not migrate the existing source. The hand-written Git codec and object store remain current, tested code until the submission boundary is designed. After that, define the facet's Computer binding, implement the sanctioned submission path, give the supervisor its independent Git read path, and then retire only the code the replacement makes obsolete.
