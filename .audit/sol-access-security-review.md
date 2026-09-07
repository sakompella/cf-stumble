# Cloudflare Access security review

Commit `0f417cfecc15be778b98665014878adba57c6ab8` does not pass this review.

## Blocking defects

### High. The verified bearer token crosses into the mutable main facet

**Location.** `src/worker.ts:16` forwards the original `Request`. The request still has `cf-access-jwt-assertion`. `src/supervisor/supervisor.ts:226` and `src/supervisor/relay/index.ts:39` pass the same request to the active main facet.

**Exploit path.** An owner sends a valid Access request. The Worker verifies the token, then gives the unchanged bearer credential to code from the active harness generation. A malicious or compromised main facet reads the header and sends it through an available capability such as `MODEL`, or retains it in output or logs. Anyone who obtains the token can replay it before `exp` and reach the owner's Supervisor. The same concern applies to a `CF_Authorization` cookie if Access leaves that cookie on the origin request.

**Minimal fix.** Build an internal request after verification. Remove `cf-access-jwt-assertion` and the `CF_Authorization` cookie before calling `SUPERVISOR.getByName(...).fetch(...)`. Prefer an allowlist for headers that the main facet needs. Add a facet test that proves the assertion and Access cookie do not cross the boundary.

### Medium. An unknown `kid` forces an unbounded JWKS refresh

**Location.** `src/access/index.ts:119-133` skips the cache when `forceRefresh` is true. `src/access/index.ts:194-205` sets `forceRefresh` after every failed signature whose `kid` is absent from the cached set.

**Exploit path.** A caller sends three nonempty base64url JWT parts with `alg` set to `RS256` and a new random `kid`. No valid signature or claims are needed. With a warm cache, every request reaches `fetchPublicKeys(..., true)` and causes one outbound cert fetch. Concurrent cold requests can each cause an initial fetch and a forced refresh because there is no in-flight request sharing. This turns unauthenticated traffic into repeated outbound work and can keep requests waiting on the cert endpoint.

**Minimal fix.** Keep one in-flight fetch per JWKS URL and apply a bounded refresh cooldown per URL. Permit at most one rotation refresh during that cooldown, regardless of the attacker-supplied `kid`. Do not store every unknown `kid`, because that would replace the network attack with unbounded memory growth. Add a test that sends many distinct unknown key IDs and asserts a fixed fetch count.

### Medium. Configuration permits unauthenticated HTTP key retrieval

**Location.** `src/access/index.ts:101-108` accepts `http://` as an issuer scheme. `src/access/index.ts:111-113` derives the cert URL from that issuer, and `src/access/index.ts:136` fetches it.

**Exploit path.** A deployment configured with `CF_ACCESS_TEAM_DOMAIN=http://team.cloudflareaccess.com` fetches the authentication keys over cleartext HTTP. An on-path attacker can return an attacker-owned JWK, sign a token with the configured issuer and audience, choose any `sub`, and reach the derived Supervisor. The exact issuer check does not help because the attacker signs the configured HTTP issuer.

**Minimal fix.** Accept only HTTPS. Parse the configured value as a URL, reject credentials, paths, queries, and fragments, and require the expected Cloudflare Access team-domain host form. A bare team domain can still normalize to `https://...`.

## Non-blocking defect

### Low. Distinct JavaScript identity strings can derive the same Supervisor name

**Location.** `src/access/verification.ts:109-110` accepts every nonempty JavaScript string. `src/access/verification.ts:295` passes the string through `TextEncoder` before hashing.

**Exploit path.** JSON permits escaped lone UTF-16 surrogates. `"\ud800"` and `"\ud801"` become distinct JavaScript strings, but `TextEncoder` replaces both with the same UTF-8 replacement character. With the same audience, both inputs therefore produce the same SHA-256 input and the same Supervisor name. Exploitation requires Access to sign both unusual `sub` values, so this does not block the current UUID-like Access identity model.

**Minimal fix.** Hash an injective encoding of the two JavaScript strings, such as `JSON.stringify([identity, audience])`, or reject unpaired surrogates while parsing `sub`. Add the two escaped-surrogate values as a regression test.

## Acceptable design choices

- `src/worker.ts:9-16` calls `getByName` only after `authenticateAccessRequest` returns success. Missing and malformed assertions fail before routing.
- `src/access/verification.ts:77-85` accepts only `RS256` and `ES256`. Unsigned tokens, `alg: "none"`, symmetric-algorithm confusion, empty signatures, and extra JWT parts fail. `src/access/verification.ts:126-174` also binds each algorithm to the correct JWK type and WebCrypto verification operation. A mismatched `kid` cannot bypass signature verification. A trusted key without a `kid` can verify a token with any header `kid`, but the caller still needs the trusted private key. The `kid` remains a key-selection hint, not an authentication fact.
- `src/access/verification.ts:270-275` compares the issuer by exact string equality and checks the configured audience as one exact array element. There is no prefix or substring match. The insecure HTTP configuration above is separate.
- `src/access/verification.ts:277-281` compares JWT NumericDate seconds against a seconds-based `now`. It rejects `exp == now` and any future `nbf`. It adds no clock skew.
- `src/access/verification.ts:109-110` requires a nonempty `sub`. Apart from the encoding defect above and impractical SHA-256 collisions, distinct normal Access identities derive distinct stable names.
- The derived name is predictable to a caller who decodes their own token because the construction is an unkeyed hash of `sub` and `aud`. This is acceptable only because a Durable Object name is not a capability and no request parameter selects it. Use an HMAC with a host secret if name secrecy becomes a requirement.
- Request headers, the URL, and the body cannot select the issuer, audience, or JWKS URL. Environment configuration selects them. Only verified `sub` and the configured audience select the Supervisor name.
- JWKS failures and malformed key sets fail closed. The cache key includes the fetcher identity and the full cert URL, so key material does not cross URLs. The single-entry cache can thrash if one isolate serves alternating configurations, but production uses one environment per isolate.
- Authentication failures return only `Unauthorized` from `src/worker.ts:10-13`. The verifier and JWKS adapter do not log errors or include token, claim, or key material in their result. The success-path credential forwarding remains a separate blocking defect.

## Verification

I read the named files from the commit with `git show`, then traced the accepted request through the Supervisor relay. I made no network or paid call. A local `TextEncoder` and SHA-256 check confirmed the escaped-surrogate collision. I did not run `pnpm verify` because this was a read-only review and the working tree already contains unrelated changes.

## Principles that changed the review

- **Boundary Discipline.** I treated the Worker-to-main-facet handoff as a second trust boundary. That exposed the bearer-token forwarding defect.
- **Type System Discipline.** I treated parsed JWT strings as untrusted external data rather than accepting the `string` type as proof. That exposed the surrogate collision.
- **Fix Root Causes.** The JWKS fix bounds refreshes and shares in-flight work. It does not add an attacker-controlled set of rejected key IDs.
- **Prove It Works.** I reviewed the exact commit objects and traced the real forwarding path. I also reproduced the identity-encoding collision locally.
