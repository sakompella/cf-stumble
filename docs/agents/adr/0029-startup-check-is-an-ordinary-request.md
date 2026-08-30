# Check a generation's startup with an ordinary request

> **Review:** Agent-only

Before a generation may be trusted to run, the Supervisor mounts it as a candidate facet of its own and sends one ordinary `fetch` request under a deadline. The generation passes when the response headers arrive in time and its body completes in time and within a byte bound, and when the status is not 5xx. Any other status passes, including 404, because answering an unknown path is what a started harness does.

The alternative was a health check the harness has to implement: a reserved path, a reserved method, or a required response body. An earlier prototype accepted only status 200 with the body `ready`. That turns the check into a permanent protocol every future generation must keep implementing, which is what `design/slices.md` warns against, and it stops proving startup the moment a harness answers the reserved path from a cache or a stub.

The check records its result against the labeled generation and never changes the active generation. A candidate mounts under a facet name derived from the labeled harness commit and its role, so a failing candidate cannot disturb the facet serving traffic, and the previous candidate facet of that name is aborted first so a re-check gets a cold start rather than a warm instance.

The deadline and the byte bound are values chosen for the local tests to be plainly bounded, not measurements. Nothing local can say what a production Dynamic Worker load plus a cold Durable Object start actually costs, so both remain provisional until a paid deployment measures them.
