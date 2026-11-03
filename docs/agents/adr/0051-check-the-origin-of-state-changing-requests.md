# Check the origin of state-changing requests

> **Review:** Human-approved

On 2026-10-30 Aditya removed Cloudflare Access and left the Worker open. Basic auth was added on
2026-11-03 and removed the same day at his request. The Worker has no login: anyone who knows the
hostname can use it.

**A state-changing request must come from the Worker's own origin.** A request other than `GET` or
`HEAD` answers 403 `cross-origin-request` when its `Origin` names another origin or its
`Sec-Fetch-Site` is not `same-origin`. `src/origin-guard.ts` runs before any route and logs
`route.cross-origin-refused`. Without a login a page on another site could otherwise make the
owner's browser send a state-changing request, so the check covers every route, not only `/api`. A
request with neither header, such as `curl`, passes. `GET` routes, including `/health` and the orb
WebSocket upgrades, are never checked.

**What replaces it.** A login that issues a session, through Cloudflare Access or GitHub sign-in,
when the Worker must stop being open. That change adds to this check and does not replace it.
