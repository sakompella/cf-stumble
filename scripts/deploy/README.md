# Deploy configuration guard

`check-config.sh` checks the required Access values before a deploy command runs. It has no network or Wrangler calls, writes no files, and can run repeatedly.

Run it in the same shell or CI job that will start the deploy:

```sh
./scripts/deploy/check-config.sh
```

The guard reads these environment variables. The shell or CI secret manager supplies the values. Do not put them in tracked files.

| Environment variable    | Value source at deploy time                                               | Worker delivery                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN` | The Cloudflare Access team domain from the Access dashboard.              | The deploy command supplies a Worker secret or a `--var` binding with this name. The Worker reads `env.CF_ACCESS_TEAM_DOMAIN`. |
| `CF_ACCESS_AUD`         | The Access application audience tag, also called the application AUD.     | The deploy command supplies a Worker secret or a `--var` binding with this name. The Worker reads `env.CF_ACCESS_AUD`.         |
| `CF_ACCESS_OWNER_SUB`   | The owner's stable `sub` subject claim from the Access identity provider. | The deploy command supplies a Worker secret with this name. The Worker reads `env.CF_ACCESS_OWNER_SUB`.                        |

A deploy wrapper must invoke the guard before it invokes `wrangler deploy`. It must pass the same environment-backed values to Wrangler. Use `wrangler secret put` for secrets, or the deploy command's `--var` option where that binding is appropriate. The guard does not set, persist, or forward any value itself.

The output reports only whether each variable is present and its character length. It never prints a value.
