# Brief: one troubleshooting entry for the deploy guide

You are the documentation and prose role for this run (`openai-codex/gpt-5.6-terra`,
`--thinking medium`).

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/deploy-troubleshoot -b work/deploy-troubleshoot origin/main
cd /home/aditya/wt/deploy-troubleshoot
```

Work only there, and change only `docs/deploy.md`.

## What happened, which is what you are documenting

The owner's instance was deployed and healthy for hours and was never reachable at its hostname.
The cause: the zone `akompella.dev` has a **proxied wildcard DNS record** pointing at another
machine, so `stumble.akompella.dev` resolved to that machine's web server. The Worker had no route
and no custom domain, so it never saw a request for that hostname. Cloudflare Access was correctly
configured and sat in front of the hostname, which made the symptom confusing: you log in through
Access successfully and then land on somebody else's website instead of cf-stumble.

The fix is a Worker route on that hostname. `wrangler.jsonc` now carries:

```jsonc
"routes": [{ "pattern": "stumble.akompella.dev/*", "zone_name": "akompella.dev" }],
```

A route rather than a custom domain, because a custom domain writes a DNS record and a route does
not, and a wildcard record already makes the hostname proxied. A reader whose zone has no wildcard
may prefer a custom domain, which creates the record for them.

Verified after the fix: an unauthenticated request to the hostname returns 302 to
`adityakompella.cloudflareaccess.com/cdn-cgi/access/login/stumble.akompella.dev` with the
application's own audience tag, and the route is listed on the zone against the script.

## What to write

Add a short troubleshooting entry to `docs/deploy.md`. It must give the reader:

- The symptom, in the words they will experience it: Access accepts the login and the page that
  appears is not cf-stumble, or the hostname answers something else entirely.
- The cause, stated plainly: a proxied DNS record on the zone, most often a wildcard, already
  points the hostname somewhere, and a deployed Worker does not claim a hostname by existing.
- How to check it, with the commands or dashboard places a reader can actually use.
- The two fixes and when to choose each, the route and the custom domain, with the DNS-write
  difference as the deciding fact.

Put it where a reader will find it when they hit this, and say in your report where you put it and
why there. Match the guide's existing voice, which is short sentences and plain technical English.
The guide has a rule this project holds itself to: no long-dash character, and no colon used as a
mid-sentence connector. A colon before a list is fine.

Do not restructure the rest of the guide. Do not touch any other file.

## Passes

Run the `writing-for-agents` skill, then `humanizer`, then `unslop` over what you wrote, and say in
your report what each pass changed.

## The gate

`pnpm verify` green before the commit; the pre-commit hook runs it. `pnpm format` fixes formatting,
and this guide has failed the format check before, so run it. Rebase on `origin/main` before you
push. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/deploy-troubleshoot`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 300 words:
branch and SHA, where you put the entry and why, the text itself, what each pass changed, and the
`pnpm verify` line.
