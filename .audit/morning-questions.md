# Morning questions

Untracked. `.audit/` is gitignored, so this file is for you only.

Each question is a decision I made tonight that you can reverse cheaply. I give my recommendation after each one. Answer with question numbers and I will apply them in one pass. The five older, larger design questions still live in `.audit/design-questions.md` and are not repeated here.

Written during the Worker Previews run. Playbook `.audit/worker-previews-adoption.md`, trail `.audit/worker-previews-adoption.tsv`.

---

❓ **Q1** - **The `previews` block now lives in `wrangler.jsonc` on `main`**: I added eleven lines that declare the SUPERVISOR Durable Object binding and the LOADER worker_loaders binding for Previews, and deliberately left the R2 binding out. Without the block, `wrangler preview` produces a Worker whose bindings are missing and `GET /` returns a 1101 error page. With it, `pnpm verify` still passes, 33 files and 168 tests. Wrangler prints a warning on every Preview deploy that MODULE_MAPS diverges from production. Keep the block, or keep it on a branch until R2 exists and the warning goes away?

➡️ Keep it. The warning is accurate and harmless, and the block is what makes the command work at all. Removing R2 from the Preview is also the only reason the probe could run on an account where R2 is disabled.

---

❓ **Q2** - **I deleted both probe Previews instead of leaving one running**: `probe0` proved the whole path on the real runtime, then I deleted it and confirmed both URLs return 404. Sol advised keeping one Access-protected Preview as the paid-runtime target for feature-map P0, but this OAuth token has no Access scope, so I could not protect it. I chose not to leave a public URL serving your Worker overnight. Do you want a long-lived Preview named something like `p0-probe` recreated, and if so, protected how?

➡️ Recreate it when you are awake and can enable Cloudflare Access in the dashboard. Two commands bring it back in under a minute, and they are in the new design doc.

---

❓ **Q3** - **The account is now back to its exact baseline, Worker record included**: the container probe needed a production deploy as a control, so the Worker briefly served throwaway probe code. I deleted the whole Worker afterwards with `wrangler delete`. `cf workers scripts list` returns `[]`, all three probe URLs return 404, `wrangler containers list` finds nothing, and the registry has no images. Nothing to decide unless you wanted the name held.

➡️ Nothing to do. The next `wrangler preview` recreates the Worker and the name in one command.

---

❓ **Q4** - **I did not change `feature-map.md`, even though the probe verified two of P0's checks**: Sol's verdict was blunt: Previews is P0 test infrastructure, not version 0 product machinery, so nothing in the feature map should change around a private-beta primitive. So the probe results went into a new file, `docs/agents/design/worker-previews.md`, and P0 keeps its checklist as written. The alternative is to mark "a cold facet made from that map passes the existing `GET /` startup check" as done in the feature map itself. Which do you want as the source of truth for probe results?

➡️ Leave the feature map alone. Its checks describe Computer-built module maps, and tonight proved the runtime accepts a locally built one. That is progress on the same question, not the same check.

---

❓ **Q5** - **I rejected making a generation candidate a Preview**: this was the interesting idea of the night and I want you to see the reasoning, because it would have deleted real work. Wrangler already builds a Worker, Cloudflare already stores immutable deployments and hands out candidate URLs, so candidate-as-Preview could remove the module-map build, the R2 artifact cache, and much of the Loader machinery. I rejected it for version 0. A Preview is a whole-Worker release seam, so previewing this Worker forks the Supervisor and the Computer workspace along with the candidate, and production cannot internally activate a Preview. My first framing of this was wrong and Sol corrected it: per-Preview Durable Object isolation alone is not fatal, since conversations could live in R2, D1, or a Durable Object owned by another Worker through `script_name`. The fatal part is that activation and workspace continuity break, not conversation storage. Do you accept the rejection, or do you want a real design pass on a two-Worker split where a stable control Worker owns state and Previews carry only harness code?

➡️ Accept the rejection for version 0. The two-Worker split is worth a design pass after the demo ships, because it would trade your custom activation machinery for platform machinery, and that is a good trade later and a rewrite now.

---

❓ **Q6** - **No ADR for any of this**: the domain-modeling rule says an ADR needs three things, hard to reverse, surprising without context, and a real trade-off. Q5 has two of the three, since choosing not to restructure is cheap to revisit. So I wrote a design doc instead of ADR-0037. Do you want the Previews rejection recorded as an ADR anyway, so a future reader finds it where the other decisions live?

➡️ Design doc is enough for now. Promote it to an ADR if you decide to keep the Loader path permanently, because that is when the alternative gets expensive to reopen.

---

❓ **Q7** - **R2 needs a free subscription that only you can add**: `wrangler r2 bucket list` returns code 10042, "Please enable R2 through the Cloudflare Dashboard". This is a missing R2 subscription, not a bill. The docs say R2 is free to start with included monthly usage, and the free tier is 10 GB-month of Standard storage, 1 million Class A operations and 10 million Class B operations, with free egress. This project stores module maps, so a map is single-digit megabytes, writes happen once per cache miss and reads once per cold facet load. The free tier covers that with room to spare. The gap blocks feature-map P2 entirely and part of P0, and closing it means completing one checkout flow at Storage and databases, R2, Overview. My token cannot add a subscription. Do it, or keep planning around the gap?

➡️ Do it. It costs nothing at this volume, and every remaining storage decision is guesswork until the binding is real. One caveat: the checkout screen is a billing flow, and I have not seen your payment state, so I cannot promise it completes without a card on file.

---

❓ **Q8** - **Access scope is missing from the local credentials**: the docs say a workers.dev Preview URL can sit behind Cloudflare Access with no custom domain, which is exactly what this project needs, and I could not verify it because the token has no Access permission. Verifying it needs either a dashboard action from you or an API token with Access rights. Which do you prefer?

➡️ Do it in the dashboard yourself the first time, then tell me what you see. Handing an agent Access-scoped credentials to your own identity provider is not a decision to make while you are asleep.

---

❓ **Q9** - **Should Previews become part of the workflow, not just a probe?**: the docs support automatic Previews per pull request through Workers Builds, or a GitHub Actions step running `npx wrangler preview --json`. That is real value later, and it is also scope you did not ask for. Do you want a CI Preview per branch once P1 exists?

➡️ Not yet. Wire it after the tenant page exists in P3, because until then there is no user-visible surface a Preview URL would let you check.

---

---

❓ **Q10** - **Container probe, answered. Which instance type do you want for Computer?**: this is the next real unknown for feature-map P0, because Computer runs as a container and the docs say each Preview gets its own container instances. I stopped short tonight. A container app bills, and deleting the Preview can leave the app listed in `wrangler containers list`. I first wrote that this account might not have Workers Paid. That was wrong, and the cause was piping the JSON subscription list through `head -30`, which dropped entries two and three. The account holds `workers_paid`, state Paid, price 5. Docker is running locally, so the probe is ready. The exact five-step procedure is in `.audit/worker-previews-adoption.md` under C12. Approve it, or should the first container deploy be yours?

➡️ Done, and it passed. A container served `container ok` inside a Preview. The finding that matters for you: `instance_type: "dev"`, now renamed `lite`, never schedules on this account, in production or in a Preview. Only `basic` worked. So when the Computer container lands, start at `basic` and do not read the silence from `lite` as a provisioning delay. The real Computer image is still untested, since this probe used a trivial busybox image.

---

❓ **Q11** - **Should the probe state route become real code?**: the isolation numbers came from a throwaway `/probe/state` route I patched into `src/worker.ts` and then reverted, which the reviewer correctly called unreproducible. I saved the file as evidence, so the numbers can be reproduced, but the next probe still needs a manual patch. A small read-only route that returns the active generation label and the relay attempt count would make every future paid-runtime probe repeatable, and it is roughly fifteen lines plus a test. It is also surface area the feature map did not ask for, and it exposes internal state on a public URL until Access is in place. Add it, or keep patching throwaway routes?

➡️ Add it, but gate it. Return the counts only, never conversation content, and put it behind the same Access policy as the tenant routes when P3 lands. The reproducibility is worth more than the fifteen lines, and tonight showed that the alternative is evidence a reviewer can shoot down.

---

❓ **Q12** - **I added a turn lease that nobody asked for**: the feature map says a second active turn for one session fails with a conflict. It says nothing about what happens when the facet holding the turn dies. All four arena candidates left that case bricked: `turn_active` stays 1 forever and only the dead caller could call `abandonTurn`. I added a deadline, so the next start after it takes the slot over and a late finish is rejected as `turn-expired`. It is one nullable column, one helper, and four tests. The argument against is that it is scope you did not approve, and that `abandonTurn` already exists as a manual escape. Keep the lease, or cut it and let the client call abandon?

➡️ Keep it. Demo step 7 rolls back the harness and continues the same conversation, which is exactly the path that crosses a facet replacement mid-turn. Without the lease that step can leave a session no one can write to again, and the fix would be a client calling an internal recovery method. `relay_attempts` already bounds a relay this way, so the pattern is yours, not mine.

---

❓ **Q13** - **You can no longer save a session without running a turn**: the arena split on this and I took the judge's side. There is no `writeSession`. A document is persisted only by `finishSessionTurn`, which saves, advances the revision and releases the slot in one transaction. That makes the turn slot mean something, since with a standalone write any caller can save while another client holds the turn. The cost is that a future feature like a title rename or a manual note has to open a turn to write one field. Accept the coupling, or do you want a separate write path back?

➡️ Accept it for version 0. The only writer today is a completed turn. If a second kind of writer appears, add it then with its own name and its own reason, rather than keeping a general write path open for a caller that does not exist yet.

## Answer sheet

Copy this, fill it in, and I will apply the whole set in one pass.

```
Q1 keep / branch:
Q2 recreate now / recreate later / leave deleted:
Q3 keep worker record / delete:
Q4 feature map untouched / mark P0 checks:
Q5 accept rejection / design the two-Worker split:
Q6 design doc / promote to ADR:
Q7 enabling R2 first / keep planning around it:
Q8 you do Access in the dashboard / issue an Access-scoped token:
Q9 CI previews after P3 / sooner / never:
Q10 approve container probe / you run the first one:
Q11 add the probe route / keep patching:
Q12 keep the turn lease / cut it:
Q13 accept turn-only writes / restore a separate write:
```
