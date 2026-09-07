## Q1

- **Candidate — partly.** A Preview can build and host candidate code at a stable URL with immutable deployment URLs. It does not replace commit identity, authorization, request journaling, candidate status, or the tenant's candidate history.
- **Startup check — no, keep it.** Previews provide a target, not a gate. The docs' automation still adds an explicit HTTP probe. Keep the bounded cold `GET /` check and its recorded result.
- **Activation — no, keep it.** A Preview cannot take production routes, and its stable URL only advances that Preview. It does not atomically change the generation selected by the tenant's stable endpoint.
- **Rollback — no, keep it.** An old deployment URL is not an epoch-checked rollback operation, nor does it restore the Supervisor's active-generation record.
- **Isolation — partly.** Previews give excellent whole-Worker code/config isolation and automatic same-Worker Durable Object/container isolation. They do not provide the required boundary between replaceable harness code and shared tenant state; in fact, their automatic isolation cuts across it.

## Q2

The strongest case is deletion of bespoke infrastructure: Wrangler builds a real Worker, Cloudflare stores immutable deployments, supplies stable candidate URLs, isolates bindings/configuration, and provides runtime observability. That could remove canonical module-map building, R2 artifact caching, and much Loader-specific machinery.

Reject it for version 0. A Preview is a whole-Worker release seam; the design needs a harness-within-a-stable-tenant-runtime seam. Previewing this Worker forks the Supervisor namespace and Computer container as well as the candidate. Production cannot internally “activate” that Preview: Preview routes do not replace production, and service bindings do not resolve to matching Previews. Making it work means splitting state/control into another production Worker, routing the harness over a public endpoint or redeploying bindings, and giving a deployment credential to some trusted control component. That is a new architecture, not simplification tonight.

The owner's reasoning is directionally right but overstated. Per-Preview Durable Object isolation is not inherently fatal: conversations could live in R2/D1 shared by bindings, or in a Durable Object owned by a separate Worker via `script_name`. The current packaging is fatal because same-Worker Supervisor and workspace state also fork. Externalizing conversation state alone would not fix activation, workspace continuity, or the control boundary.

## Q3

1. Use one manually named, Access-protected Preview as the disposable paid-runtime target for P0. Deploy the static shell with the fixture, then prove same-Worker Supervisor isolation, `worker_loaders` availability, container startup, and the real cold `GET /`. Do this from a trusted operator/CI context, not from the mutable coding workspace.
2. After P3 exists, use a Preview for branch-level page and route smoke tests against immutable deployment URLs. Do not automate PR Previews before one manual Preview proves the configuration and cleanup behavior.

Nothing involving R2 is needed to get value from item 1. A Preview does not remove the later R2/Loader proof.

## Q4

**Nothing.** Previews are useful P0 test infrastructure, not version 0 product machinery. `P0: prove the paid Cloudflare path` already tells the project to use a tiny temporary facet and preserve runtime evidence. Record the chosen Preview command and isolation caveats in that probe's procedure/evidence, not in `feature-map.md`. Do not change **What version 0 is**, **The demo**, **P2**, or **Build order** around a private-beta deployment primitive that does not implement activation or rollback.
