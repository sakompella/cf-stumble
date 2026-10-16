# Sandbox every relayed response into an opaque origin

> **Review:** Agent-only

Every response the Worker relays from the active generation carries a policy the host adds:
`content-security-policy: sandbox allow-scripts; frame-ancestors 'none'`, and the Worker removes
every `Set-Cookie` header the generation sent. The cleanup run's fresh
review found the gap on 2026-10-13, and the orchestrating agent chose this fix. No human has
approved it.

**Why.** The relay serves generation output on the owner's origin, to a browser that holds the
owner's Access session. Without a policy, an HTML document from the generation could fetch
`/api/status` and post to `/api/generations/activate` or `/api/workspace/reset`: Access admits the
browser's cookie, and the request's `Origin` matches, which is all the owner API checks. Mutable
code would then act with the owner's authority without the owner asking. ADR-0024 lets the main
facet request generation changes, but through a request path the Supervisor checks, not through
the owner's browser.

**What the policy does.** `sandbox` without `allow-same-origin` runs a relayed document in an
opaque origin, whatever its content type.

- Its requests to `/api/` are cross-origin. A `POST` carries `Origin: null` and
  `Sec-Fetch-Site: cross-site`, and the owner API refuses both. A form cannot submit at all,
  because `allow-forms` is not granted.
- The owner API sends no CORS headers, so the document cannot read an owner API answer, even when
  the browser attaches the Access cookie to a credentialed request.
- No owner API `GET` changes owner state or reaches the workspace, so a request the document
  causes without reading it, or a navigation of its own window to `/api/...`, gains nothing. The
  GitHub connection refresh, which wakes the workspace container, is a `POST`.
- A service worker cannot be registered from an opaque origin, and the document cannot open
  pop-ups or reach `document.cookie` or same-origin storage.
- `frame-ancestors 'none'` matches the owner page, so no site can frame generation content.

Scripts stay allowed, because the sandbox already denies them the owner API. The owner page, its
hashed script, the owner API, and `/health` are host responses and keep their own policies.

**Cookies.** A cookie that a relayed response sets belongs to the owner's origin, whatever the
sandbox does to the document. A generation could set a junk `CF_Authorization` cookie with
`Path=/api`. The browser sends the more specific path first, so the owner's API requests, rollback
included, could carry the junk value instead of the real token. Rollback is the owner's recovery
from a bad generation, so the Worker drops every `Set-Cookie` from a relayed response. A
generation has no legitimate reason to set cookies on the owner's origin.

**Merging.** The Worker appends its policy to any `content-security-policy` the generation set,
so the header holds both policies. A browser enforces each policy and combines their sandbox
restrictions, so a generation's policy can restrict its document further but cannot lift the
host's sandbox.

**Cost.** A generation cannot serve a browser application that sets or uses cookies, storage, or
the owner API on this origin. Generation 0 serves only a text readiness answer, so nothing changes for it.

**Alternatives.** Refusing active content types from the relay is easier to bypass, because a
browser renders more types as documents than a deny-list names. Serving generation content on a
separate origin is the cleaner design if generation-hosted browser applications become a product
feature, but it needs a second hostname and a second Access application.
