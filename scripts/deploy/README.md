# Deploy configuration guard

`check-config.sh` checks the required Access values before a deploy command runs. It has no network or Wrangler calls, writes no files, and can run repeatedly.

Run it in the same shell or CI job that will start the deploy:

```sh
./scripts/deploy/check-config.sh
```

The guard reads these environment variables. The shell or CI secret manager supplies the values. Do not put them in tracked files.

| Environment variable        | Value source at deploy time                                               | Worker delivery                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN`     | The Cloudflare Access team domain from the Access dashboard.              | The deploy command supplies a Worker secret or a `--var` binding with this name. The Worker reads `env.CF_ACCESS_TEAM_DOMAIN`. |
| `CF_ACCESS_AUD`             | The Access application audience tag, also called the application AUD.     | The deploy command supplies a Worker secret or a `--var` binding with this name. The Worker reads `env.CF_ACCESS_AUD`.         |
| `CF_ACCESS_OWNER_SUB`       | The owner's stable `sub` subject claim from the Access identity provider. | The deploy command supplies a Worker secret with this name. The Worker reads `env.CF_ACCESS_OWNER_SUB`.                        |
| `CF_STUMBLE_HARNESS_COMMIT` | The full harness commit the deploy publishes, from `git rev-parse HEAD`.  | The Worker receives no binding for it. The owner submits it after the deploy, as the Generation 0 step below describes.        |

## The Access application and policy this Worker requires

The Worker verifies the token itself, but it verifies it against one application and admits one
subject. A deploy that configures the application differently leaves the Worker refusing every
request, so record these three facts with the deploy.

1. **One self-hosted Access application** covering the deployed hostname and every path under it,
   including `/api/`. The Worker has no unauthenticated route: a request without a usable token is
   `401`, whatever it asks for.
2. **One policy on that application, of action Allow, with a single include rule that names the
   owner's identity** — the owner's email through the configured identity provider. The application
   audience tag is `CF_ACCESS_AUD` and the owner's stable `sub` claim is `CF_ACCESS_OWNER_SUB`. The
   Worker checks the `sub` itself, so an Access policy that admitted a second identity would still
   be refused here; the two are configured to agree, and the Worker is the one that fails closed.
3. **No bypass, service-token, or "everyone" rule** on the application, and no second policy. The
   Worker takes the tenant from the verified token alone: it refuses any request that also carries
   a `tenant`, `identity`, `audience`, `workspace`, or `supervisor` query parameter, or the matching
   `x-cf-stumble-*` header, with `400` rather than serving it and ignoring the field.

`test/access/tenant-selection.test.ts` and `test/access-owner.test.ts` hold the Worker side of this
to its contract locally. The application and policy themselves are deployed configuration, so they
are checked when the owner deploys.

`CF_STUMBLE_HARNESS_COMMIT` must be a full SHA-1 or SHA-256 Git object ID in lowercase hexadecimal, because a generation is one specific labeled commit (ADR-0002). A branch name or a short ref fails the guard rather than the submission.

A deploy wrapper must invoke the guard before it invokes `wrangler deploy`. It must pass the same environment-backed values to Wrangler. Use `wrangler secret put` for secrets, or the deploy command's `--var` option where that binding is appropriate. The guard does not set, persist, or forward any value itself.

The output reports only whether each variable is present and its character length. It never prints a value.

## Generation 0 after the deploy

A deployed Worker serves nothing yet. The Supervisor holds no built-in harness code and labels no generation of its own, so a request to it answers `503` with `{"ok":false,"problem":{"code":"no-active-generation"}}` until a generation is active. Generation 0 is an ordinary owner submission of the commit the deploy published.

Run these two steps as the owner, through Cloudflare Access, against the deployed hostname:

1. Submit the deployed harness commit. The Supervisor labels it, and the first submission takes label 0. It then prepares that label: it builds the commit or reads its cached module map, and runs the bounded startup check.

   ```sh
   curl -sS "https://$CF_STUMBLE_HOSTNAME/api/generations/submit" \
       -H 'content-type: application/json' \
       -d "{\"harnessCommit\":\"$CF_STUMBLE_HARNESS_COMMIT\"}"
   ```

   Read `outcome.generation.label` and `preparation.report.stage` from the response. Continue only when the stage is `ready`. A failed check is recorded against that label and changes nothing else.

2. Activate the labeled generation with the epoch `GET /api/status` reports.

   ```sh
   curl -sS "https://$CF_STUMBLE_HOSTNAME/api/generations/activate" \
       -H 'content-type: application/json' \
       -d "{\"observedEpoch\":$EPOCH,\"label\":$LABEL}"
   ```

There is no request journal (ADR-0030). Repeating the submission returns the existing generation
instead of labeling the commit twice, and repeating the activation once it observes the current
epoch is a no-op instead of acting twice. Repeating a step with a stale observed epoch still fails.
The Supervisor decides both steps; naming a target does not perform it (ADR-0003).
