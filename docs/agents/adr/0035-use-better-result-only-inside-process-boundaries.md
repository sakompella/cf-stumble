# Use better-result only inside process boundaries

> **Review:** Agent-only

Use `better-result` Results and TaggedErrors for known recoverable failures whose producer and consumer run inside one Worker isolate. Match each Result exhaustively into the existing plain domain value before data leaves that isolate.

Every public method on the Supervisor Durable Object must return its declared plain RPC type. A live `Result`, `Ok`, `Err`, `TaggedError`, or `Panic` must not appear in an RPC argument or return value. These values are application-defined classes with custom prototypes and do not extend `RpcTarget`, so Durable Object RPC cannot carry them and structured clone does not preserve their behavior. `TaggedError.toJSON()` does not change the RPC contract.

Keep SQLite rows, R2 objects, Worker Loader inputs, facet environment values, and recovery or relay records as explicit plain values. Keep `Request` and `Response` as their platform types. An adapter at each boundary must expose the current stable codes and safe fields without causes, stacks, or internal error messages.

Do not use `Result.codec` to replace an existing `{ ok, ... }` RPC contract with the package's `{ status, ... }` envelope. A future interface may define a versioned codec when it needs a serialized Result contract, but that interface must validate both payloads and test the encoded values through workerd.

The alternative is to return live Results or codec envelopes from Supervisor methods. Live Results fail the platform's class rules. Codec envelopes would change every current caller and durable representation without adding a validation requirement that cf-stumble has today.

This decision preserves ADR-0003's Supervisor authority, ADR-0029's plain startup-check report, and ADR-0030's plain journaled generation result.
