# Apply generation requests directly

> **Review:** Human-approved

A generation request carries a principal and a command. The Supervisor checks the request and
applies an accepted change directly to the generation tables in one SQLite transaction. A request
does not carry a request ID, and the Supervisor does not store command fingerprints or a control
request journal.

Candidate submission is safe to repeat because labeling a harness commit that already has a
generation returns the existing generation. Activating the generation that is already active is a
no-op. Activation and rollback carry the epoch the requester observed, as ADR-0033 requires, so a
request based on older generation state is rejected.

If a caller loses a response, it reads the current generation state before deciding whether to send
another command. The Supervisor does not reproduce the exact response to an earlier delivery. This
keeps version 0 small and gives up a durable record of rejected commands and exact response replay,
neither of which is a product requirement.

An ordered event log would be a different design. It would record every generation mutation,
including labels, preparation checks, activation, and rollback, then derive current state from those
events. Version 0 instead keeps current state in the generation tables and retains only the
preparation and activation history that its behavior uses.

The implementation still has `requestId`, command fingerprints, and
`generation_control_journal`. It must remove them from the page, routes, RPC types, Supervisor, and
tests before the code matches this decision.
