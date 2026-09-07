# Paid runtime evidence

Run `probe-1788408728`, 2026-09-03.

## What ran

`scripts/probe/run.sh` deployed a disposable Worker named `cf-stumble-probe-p0-1788408728`,
protected it with a single-run bearer secret, called it once, then deleted everything it
created. The account was authenticated by the existing wrangler login.

## Result

| Check | Outcome |
| --- | --- |
| R2 write to `cf-stumble-module-maps` | passed |
| R2 read back and compare | passed |
| Fixed Workers AI route, `@cf/zai-org/glm-5.3-flash`, `reasoning_effort: "low"` | passed |

The recorded evidence is `scripts/probe/evidence/result-1788408728.json`. It stores
`model_responded` only. No prompt, response body, token, or key is written to disk.

## Cleanup

The probe deleted its R2 object and its Worker, then verified each was gone. The probe URL now
returns 404 and the R2 object is absent. The `cf-stumble-module-maps` bucket remains because
version 0 needs it.

## Not proven yet

The pinned Computer container, a real Pi coding turn, candidate module-map build and load, and
the Access-protected production deployment.
