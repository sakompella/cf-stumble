# Realignment transcript notes

## Read this first

- "One connected project" means one external GitHub repository, plus the harness as a special second sidebar entry. It does not mean two connected repositories. [Transcript 5200-5206]
- The harness entry only selects `/workspace/harness`, which is the existing editable Git clone. It does not create another clone, workspace, session type, or commit system. [Transcript 4551-4559]
- The README button must run the real repository through the actual Deploy to Cloudflare flow, end to end, against a clean target. The platform's supported-resource list is not proof. [Transcript 4872-4881, 5164-5169]
- "Proved once" includes empty cf-stumble storage, Supervisor-driven bootstrap through the normal submission path, safe retry, and fail-closed behavior before Access is configured. Do this before writing the deploy instructions. [Transcript 4947-4968]
- Paid Cloudflare use is approved. Replace the old evidence matrix with the deployed demo path, raw probe notes, and the two specific generation logs. The recording is not test evidence. [Transcript 4587-4590, 4650-4657, 4893-4901]
- The later owner directive makes the video human work. Agents stop after the button, deploy instructions, and the plain-text or screenshot evidence named in the handoff. [Handoff 29-37]
- Delete the production fixture only from application construction. The transcript gives no fixture name, file, resource, or broader deletion scope. [Transcript 4967]

## Authority and how to read this transcript

The export flattens the conversation. Several owner comment bodies appear only as a comment count. The following assistant comment replies and consolidated recaps record the accepted result. Where an early reply and a later reply differ, use the later settled result.

The transcript is incomplete at its end. It preserves "main workhorse is opus, review with sol. update tmp handoff doc" [Transcript 5229], then ends with `3 comments` and no comment bodies. [Transcript 5234-5235] It contains no `poteto`, Terra, Luna, human-made-video, persistent-goal, or always-push instruction. Those rules appear only in the handoff's later, highest-authority section. Treat them as later owner decisions, but do not claim the transcript independently proves their exact wording.

The owner said this session was "just for planning" and would be handed to other agents. [Transcript 3563] That limits what the planning session itself was meant to change. It does not tell the present executor to stop, because the later handoff is the execution brief.

The owner also asked for a simple refresher [Transcript 5192] and objected when the summary was "too terse". [Transcript 4739] Plan and deploy documentation should explain the mechanism in plain language, not merely list task labels. The handoff's Terra writing workflow makes this stronger and more specific.

The last raw execution-role instruction in the transcript is "main workhorse is opus, review with sol." [Transcript 5229] The handoff resolves those aliases and adds the specialized roles. Use the handoff's exact model selectors and thinking levels, not the planning-session Sonnet and Astra commands.

## Scope that changes execution

### Exactly what counts as the project list

The settled recap says "one connected repo, plus the harness itself shown as a project." [Transcript 5204-5206]

Therefore the intended sidebar contains:

1. One ordinary project connected through GitHub.
2. One special harness entry backed by the existing harness checkout.

The word "or" in demo step 2 means the user can select either entry for a turn. It does not mean the deployment contains only one of them. It also does not restore the old requirement for two external GitHub repositories.

Both entries use the one durable Computer workspace already built. Per-project Computer instances stay after v0. [Transcript 4172-4175, 4591-4597]

There is one current Pi thread per project. "Fresh thread" replaces it. There is no session entity, session list, session-scoped routing, or per-session Computer provisioning. [Transcript 4229-4238]

### The harness-as-project entry

`/workspace/harness` is a normal Git checkout. The agent edits and commits there. Candidate submission names that commit SHA. The build uses `git archive` to copy that commit into `/workspace/.builds/<commit>`. [Transcript 4551-4557]

The sidebar entry is only a working-directory selection for `/workspace/harness`. It needs no new commit mechanism. [Transcript 4557-4559]

An earlier logical description said the harness project had an empty `/repo` and a present `/harness`. [Transcript 4172-4175] Do not turn that view into new storage or routing machinery. The later concrete path above settles its implementation.

### What the Deploy to Cloudflare button must prove

Use the real public repository, `https://github.com/sakompella/cf-stumble`. The transcript verified its visibility as `PUBLIC`. [Transcript 5140-5148] No public mirror and no repo-publication approval gate remain. [Transcript 5184-5189]

The button form is `https://deploy.workers.cloudflare.com/?url=<repo>`. [Transcript 4832-4834]

A passing proof must exercise this repository through the actual button flow against a clean target. It must not infer compatibility from the general list of supported bindings. [Transcript 4872-4881, 5164-5169]

The flow must cover the button and the documented manual residue together:

- The user's fork supplies the harness repository URL through one Wrangler variable. The transcript does not name that variable. [Transcript 4953-4956]
- The button handles the repository clone/fork, declared supported resources, Workers Builds CI, and deployment. [Transcript 4832-4834]
- The instructions cover Workers Paid, the Access application and owner policy, `CF_ACCESS_*`, Computer/container setup, and `gh login` inside the workspace. Container support was not on the button's supported-resource list and must be verified, not assumed. [Transcript 4990-5021]
- The revised transcript also required the deploy instructions to identify the pinned Computer image as public GHCR, amd64-only, with no owner-specific pull credential. [Transcript 4665-4671, 4791-4812] The current handoff body dropped this detail. Restore it in deploy documentation unless verification disproves it.

### What "proved once against a clean account" means

The transcript combines two proofs:

1. Run the actual Deploy to Cloudflare path end to end against a clean target. [Transcript 4872-4881, 5164-5169]
2. Start with genuinely empty cf-stumble account storage and exercise bootstrap before writing the deploy instructions. [Transcript 4964-4968]

The bootstrap is concrete:

1. The deployed Worker remains the serving code while no generation exists.
2. The Supervisor provisions the workspace and clones the configured fork into `/workspace/harness`.
3. It labels the clone's HEAD as the first candidate.
4. It runs `pnpm run build:artifact`, stores the module map in Supervisor SQLite, runs the `GET /` cold check, and activates through the normal submission path.
5. Repeating the same commit returns the known generation. A failed build leaves the deployed Worker serving.
6. With missing or partial `CF_ACCESS_*`, every route must return the `invalid-configuration` refusal.

[Transcript 4947-4968]

The transcript does not say the Cloudflare account must contain no unrelated resources. It does require a clean deployment target and empty cf-stumble storage. It also does not name the Cloudflare account.

### The production fixture deletion is narrow and unnamed

The final wording is "Delete the production fixture from application construction." [Transcript 4967]

No fixture symbol, file, row, generation, binding, or Cloudflare resource is named. Treat application construction as the scope. Locate the fixture during implementation, prove clean bootstrap replaces it, and do not delete unrelated test fixtures based on this sentence.

### Acceptable evidence for paid work

The owner voided the old paid-approval ceremony and approved deploying early to the real paid account. [Transcript 3597-3600, 4587-4590]

Acceptable evidence is small and tied to the release path:

- Before deletions, record one deployed smoke result: the page loads behind Access and the status route answers. Repeat it after the simplification commits. [Transcript 4647-4654]
- For facet, Computer, build, Worker Loader, and streaming probes, record raw timings and failures as probe notes. [Transcript 4655-4657]
- Capture deployed logs showing that a failed candidate leaves the active generation serving and that rollback loads the stored module map without a build. [Transcript 4893-4901, 5054-5057]
- Run the real button and documented manual steps from the clean target. General Cloudflare documentation is not evidence for this repository. [Transcript 4872-4881]
- The demo recording does not replace a correctness test or these logs. [Transcript 4893-4901]

The handoff permits the two generation facts to be retained as plain text or screenshots for the human narrator. [Handoff 29-33]

No Cloudflare account name, resource prefix, or spend ceiling appears in the settled transcript or handoff. An older request explicitly asked for a named non-production account or resource prefix because probes could overwrite resources. [Transcript 3025-3049] Later approval removes the spend-approval gate, but it does not supply those values. Do not invent them or treat "Workers Paid" as an account name.

## Things not to rebuild

### Cuts made in this realignment

- Do not reconnect a second external repository or restore two-project separation checks. [Transcript 4591-4592]
- Do not build per-project or per-session Computer instances, a session list, parallel sessions, or session-scoped file state. [Transcript 4172-4175, 4229-4238]
- Do not restore R2 module-map caching, corruption recovery, eviction, the double-build reproducibility gate, cache age policy, or the SQLite-schema-deletion test. Keep built maps in Supervisor SQLite. [Transcript 4149-4152, 4598-4604]
- Delete recovery episodes, eligibility, completed-turn credit, relay-attempt tracking, their HTTP route, the page status drawer, and their tests. Keep the turn lease. [Transcript 4154-4158, 4605-4609]
- Do not rename `tenantKey` or remove `deriveSupervisorName` or the owner check. Delete only the caller-supplied-tenant guard and named cross-tenant tests, in its own revertible commit. [Transcript 4143-4147, 4610-4618]
- Fix the unnamed-Durable-Object fallback in a separate commit by throwing instead of using `ctx.id.toString()`. [Transcript 4089-4096, 4619-4622]
- Do not restore forced-compaction proof, paid disconnect/deadline evidence, shared-container concurrency evidence, or GitHub-credential-reconnect evidence as release gates. [Transcript 4623-4626]
- Do not resurrect replay validation for v0. The accepted cold `GET /` startup check is the smaller gate. [Transcript 3538-3541]
- Do not create a broad test rewrite. The optional pass can delete only named decorative tests, tests of deleted code, and obvious duplicates. It can add at most two or three properties using existing tooling. Keep it isolated and abandon it when the deploy path passes. [Transcript 4160-4164, 4980-4987]
- Do not add more decision cycles, audit machinery, harness tooling, or other work off the critical path. Verification of the executor's own commits is exempt. [Transcript 4642-4645]

### Earlier ideas the owner had already refused

The handoff refers to the feature map's postponed lists but does not spell out every original refusal. Do not revive these while "finishing the original idea":

- A tool marketplace or large bespoke tool catalog. [Transcript 2359-2362]
- A standalone `generations` library. The owner's quoted reason was "a library is not good. it has to be a standalone project." [Transcript 2370-2373]
- A Cloudflare OS PR as the main deliverable. The owner wanted "a project that's mine." [Transcript 2374-2377]
- Cloudflare Artifacts for v0. The quoted decision was "no chance. skip." [Transcript 2380-2381]
- Multi-user scope, multi-project scope, and a broad UI. [Transcript 2382-2387]
- `patch.md` as the flagship. At most it was a rough example after core work. [Transcript 2520-2527, 2544-2549]
- Hand-rolled Git object storage, Git notes for validation metadata, a separate debug image, or a working-tree checkout as the live pointer. [Transcript 2550-2566]
- Triage agents, standalone rate-limiter/sharded-KV/Raft exercises, agentOS as a dependency, and code-server in v0. [Transcript 1887-1891, 2567-2572, 3524-3526]

The later realignment also makes public deployment mean a public repository that each user deploys into their own account. It does not mean a public shared agent instance. [Transcript 4223-4227]

## Contradictions and later decisions

### Agent-made recording versus human-made recording

The end-of-transcript plan still says an agent should "record the video" and that only its posting destination remains for the owner. [Transcript 5200, 5224-5226]

The handoff records a later owner directive: "The demo video is human made" and removes capture, editing, and publication from agent scope. [Handoff 29-33] This later handoff directive wins. The executor stops after the deploy button, deploy instructions, and narration evidence.

The handoff body still calls the recording part of the deliverable and says step I includes "deploy docs + the recording." [Handoff 52-55, 218] Those are stale remnants. Apply the highest-authority directive at handoff lines 29-37.

### Access frozen versus bootstrap fail-closed proof

The early settled text says Access stays exactly as built and adds no new Access criteria. [Transcript 4582-4586] The later bootstrap review requires missing or partial `CF_ACCESS_*` to reject every route with `invalid-configuration`, and requires the executor to verify and document that behavior. [Transcript 4964-4968, 5051-5053] The later, narrow safety requirement wins.

### Paid work deferred versus approved

The original design extraction quotes "No on Workers Paid tonight." [Transcript 2573-2574] The later realignment says Workers Paid was always acceptable for this finishing run and orders deployment first. [Transcript 3597-3600, 4587-4590] The later decision wins. This is approval to use paid services, not a missing account identifier.

### Simplifications first versus baseline deployment first

An intermediate recap put simplification commits before deployment. [Transcript 4177] Astra later required one baseline smoke deployment before any deletion, followed by the same smoke after the deletions. [Transcript 4448-4453, 4647-4657] The later order wins.

### Keep recovery bookkeeping versus delete it

An early answer said recovery, eligibility, and turn credit should stay inert. [Transcript 3771-3774] After sizing the subsystem, the later answer explicitly flips and deletes it while retaining the lease. [Transcript 4154-4158] The handoff follows the later answer.

### Drop test cleanup versus retain a bounded side pass

An early answer dropped the test-cleanup task entirely. [Transcript 3782-3786] A later accepted answer reinstated a bounded, non-blocking deletion pass. [Transcript 4160-4164] Astra then required a separate branch, green-only merge, and abandonment when deployment passes. [Transcript 4980-4987] The handoff follows the later form.

### Public shared instance versus public repository

One intermediate answer said making the project public later could be a change to Access policy. [Transcript 4166-4169] The owner then adopted the clearer rule: v0 is a repo others deploy to their own accounts, not an instance strangers share. [Transcript 4223-4227] The handoff follows the later rule.

### Publication-ready button versus already-public repository

Astra first assumed the repository was private and made a public mirror an approval gate. [Transcript 4850-4857, 5106-5115] The later read-only GitHub check proved `sakompella/cf-stumble` is public, removing that gate and the mirror. [Transcript 5140-5148, 5184-5189] The later result wins.

The handoff still says "Publishing the recording/repo stays a separate owner decision" in its step I body. [Handoff 236] Ignore the `/repo` half. The repository is already public. Only the human recording's destination remains outside agent scope.

### Video diff versus correctness evidence

An earlier plan said the recording's displayed diff was the evidence that mattered for `work/T17`. [Transcript 4640-4641] Astra later rejected that equivalence and required the green-branch rule plus deployed generation logs. [Transcript 4893-4901] The handoff follows the later evidence rule.

## Concrete values and gaps

Use these exact values:

- Repository: `https://github.com/sakompella/cf-stumble`, public. SSH origin observed as `git@github.com:sakompella/cf-stumble.git`. [Transcript 5140-5148]
- Deploy-button template: `https://deploy.workers.cloudflare.com/?url=<repo>`. [Transcript 4832-4834]
- Harness checkout: `/workspace/harness`. Build extraction: `/workspace/.builds/<commit>`. [Transcript 4551-4557]
- Build command: `pnpm run build:artifact`. Candidate cold check: `GET /`. [Transcript 4947-4960]
- Computer image: `ghcr.io/cloudflare/computer-computerd-linux-x64`. It is public and amd64/x86-64; the arm64 Mac cannot run it. [Transcript 2821-2823, 3010-3013]
- Mac checkout: `~/repos/projects/cf-stumble`. hp checkout: `~/repos/cf-stumble`, reached with `ssh hp-server`. [Transcript 4686-4688]
- Browser harness on hp may need `CF_STUMBLE_CHROME="$(command -v chromium)"`. [Transcript 2830-2833]
- Verification: `pnpm verify`. Browser proof: `pnpm harness:browser`. [Transcript 4683-4685]
- Preserve R2 state on branch `keep/r2-module-cache`. The paused real-Git test branch is `work/T17`. [Transcript 4149-4152, 4579-4580]
- Execution roles: the raw owner instruction says Opus workhorse and Sol reviewer. [Transcript 5229] The exact aliases and the Terra/Luna exceptions are in handoff lines 15-28.

Do not reuse the old intermediate release SHA `9ac4b9c` or its 117/842 test count. [Transcript 2826-2829] The handoff's later baseline is `e769586`, 118 test files, and 852 tests. [Handoff 129-130]

The transcript does not provide:

- A Cloudflare account name or account ID.
- A deployment resource prefix.
- A spend ceiling.
- The Wrangler variable name for the harness fork URL.
- A production-fixture symbol or file.
- A final recording destination.

No secret or token is copied here.
