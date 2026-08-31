# Check a generation's startup with an ordinary request

> **Review:** Agent-only

Before a generation may be trusted to run, the Supervisor mounts it as a candidate facet of its own and sends one ordinary `fetch` request under a deadline. The generation passes when the response headers arrive in time, its body completes in time and within a byte bound, and its status is below 400. The Supervisor is the client for this request. A 4xx means that the candidate rejected the required startup request, so it does not prove that the candidate can accept the Supervisor's request.

The startup request is `GET /`. Every candidate must accept that request with a status below 400, so this is a minimum request contract. The contract does not require a health-specific path, a magic body, or one exact success status. An earlier prototype accepted only status 200 with the body `ready`. That would make the check a protocol that a candidate can satisfy with a cached or stubbed response rather than proving that its ordinary request handling started.

The check records its result against the labeled generation and never changes the active generation. A candidate mounts under a facet name derived from the labeled harness commit and its role, so a failing candidate cannot disturb the facet serving traffic, and the previous candidate facet of that name is aborted first so a re-check gets a cold start rather than a warm instance.

The deadline and the byte bound are values chosen for the local tests to be plainly bounded, not measurements. Nothing local can say what a production Dynamic Worker load plus a cold Durable Object start actually costs, so both remain provisional until a paid deployment measures them.
