# Review: docs/agents/design/worker-previews.md

ACCURATE WITH FIXES. Every quoted number, ID, URL, status code and body string checks out, and every
cited path exists. The faults are attribution, reproducibility, and two overstatements. Worst first.

F1. FAIL check 5. Line 53 "It ships in this repository" is false. `git show HEAD:wrangler.jsonc` has
no `previews` key, and `git status` lists wrangler.jsonc as modified in the working tree only. Step 1
branches off HEAD, so the worktree has no block, step 2's "confirm" fails, and step 3 deploys with no
SUPERVISOR or LOADER binding. repo-fit.md items 6.1 and 6.2 predict a 1101 page, not `main facet
ready`. Commit the block or make step 2 an add. The quoted JSONC itself matches the block exactly.

F2. FAIL checks 4 and 7, strongest overclaim. Line 12 "retained Durable Object state across
deployments. Its relay `attemptCount` moved from `4` to `7`". isolation-probe0.txt labels that move
itself: before traffic 4, three `GET / -> 200`, "state after 3 requests" 7. That is three requests in
one deployment, not a redeploy, and no file records a probe0 redeploy. Cross-deployment persistence
is a docs claim (facts.md section 2). The only empirical hint is the nonzero start of 4. The TSV
repeats the same misreading, so the doc inherited it.

F3. FAIL checks 1 and 5. Lines 12-13 are unreproducible. `attemptCount` appears nowhere in `src/` or
`test/`; the only repo-wide hits are the doc itself. `src/worker.ts:7` forwards every request to
`env.SUPERVISOR.getByName("facet-spike").fetch(request)`, and no route returns that state JSON. The
isolation probe ran a modified worker that was never preserved. A reader following "Reproduce the
probe" gets the three curls and no isolation result.

F4. FAIL check 1. Line 13 cites two isolation files for `facet-spike`; neither contains that string.
It is in `src/worker.ts:7` only, and per F3 the probe ran code not in the repo.

F5. Check 3, the isolation claim is weaker than stated. The two files prove that probe1 read 0 fresh,
went to 1 on its own traffic, and probe0 stayed at 7, so the two Previews did not share this one
Durable Object's storage. They do not prove the split is per-Preview namespace by design, do not test
production (never deployed; cleanup.txt shows the production URL 404 and `workers list` `[]`), and
cover one counter in one class. Line 13 generalizes a single pair. Warranted wording: two Previews of
this Worker did not share Supervisor state, consistent with the documented per-Preview namespace.

F6. FAIL check 6. Line 35 overstates sol-verdict.md. sol Q2 says per-Preview Durable Object isolation
"is not inherently fatal" and names two escapes, state in R2/D1 shared by bindings, or a Durable
Object owned by a separate Worker via `script_name`, and says the current packaging is what is fatal.
"Keep the current isolation logic" endorses the status quo and drops both escapes.

F7. Check 6. Line 29 drops sol Q3 item 1's conditions: manually named, Access-protected, run from a
trusted operator or CI context. The doc keeps none, while line 25 marks Access INCONCLUSIVE.

F8. Check 7. Line 10 is inference shown as observation, and it does hold. `main facet ready` exists
only as module source at `src/facet/fixture.ts:24`, `src/worker.ts:7` offers no other path, and
`src/supervisor/supervisor.ts:176` mounts through `this.env.LOADER` on every request. So one 200 with
that body implies all four links. Code reading carries that, not the probe alone.

F9, minor, check 1, line 11. "loaded more than one module" needs `src/facet/fixture.ts`, where
`main-facet.js` imports `./ping.js`. curl-root.txt alone cannot show module count.
F10, check 4, line 19. C12 is stronger: `cf user subscriptions get` shows only a zone-scoped free
plan, and its first reason is authorization, not billing.
F11, check 1, line 25. baseline/whoami.txt ends at "Token Permissions:" with an empty list, so the
missing Access scope is undocumented. INCONCLUSIVE stays right.
F12, check 1, line 95. facts.md never says "application ID". The prefix `cf-stumble_probe-container_`
is in adoption.md C12.
F13, check 4, line 15. "because the Preview configuration omitted R2" is causal and untested.

PASS. Check 1: the deployment ID, probe0 URL, HTTP/2 200, `main facet ready`, `pong`, `[]`, 404,
10042, "No containers found.", 4, 7 and 0 all appear verbatim. Check 2: all cited paths exist,
feature-map.md included. Check 4: "Not verified" and "Inconclusive" hold up.
