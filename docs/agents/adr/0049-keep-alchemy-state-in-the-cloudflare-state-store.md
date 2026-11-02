# Keep Alchemy's state in the account's Cloudflare state store

> **Review:** Agent-only

`infra/alchemy.run.ts` deploys the Worker with Alchemy, which compares the stack with the state it
saved after the last deploy. That state has to live somewhere every deploying machine can read.

**The state lives in `Cloudflare.state()`.** The first `plan` or `deploy` on an account creates the
Worker `alchemy-state-store`, a Durable Object with SQLite, and keeps its bearer token and
encryption key in the account's default Secrets Store. Each machine caches the address and token
under `~/.alchemy/profiles/`. The store lives in the account it describes, so whoever can deploy can
read it, and it needs no service outside Cloudflare.

**Local state was rejected.** Alchemy's default writes `.alchemy/` in the working directory. Each
machine and each worktree would then hold its own state. A deploy from a second machine would try to
create a Worker that already exists, and a lost checkout would lose track of production. A Postgres
or S3 store would work across machines, but it is a second service to run for one Worker.

**Evidence.** In the staging rehearsal, a deploy from the Mac, a plan from the Mac after `.alchemy/`
was deleted, and a plan from hp all read the same state, and the second and third were no-ops. The
stack names files relative to the repository root, so absolute paths do not make one machine's plan
differ from another's.

**Consequences.** The state store is shared by every stack and stage on the account. Do not delete
it while a stage exists; if it is lost, deploy with `--adopt` to take the existing resources back.
Alchemy does not detect changes made outside it, so a dashboard edit or a `cf deploy` rollback needs
a later `deploy --force`. Nothing in the documentation promises that two deploys of one stage at the
same time are safe, so deploy from one place at a time. Images are built by the deploying machine,
which needs Docker.
