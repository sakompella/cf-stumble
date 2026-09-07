# E3 — Three independent encodings of the superseded per-project workspace layout

Status: CONFIRMED by the root agent. Blocks goal criterion 3.
Sharpens architecture-critique finding 2 and roadmap task T3.

ADR-0038 and ADR-0039 (both human-approved) say: ONE shared Computer workspace per
tenant, holding the harness repository and every project repository as separate
directories. The code still encodes the layout those ADRs replaced, in three places.

## 1. The container name hashes the project id

`src/workspace-names.ts`:

```ts
`${input.identity}\u0000${input.audience}\u0000${input.project.id}`  -> SHA-256 -> `access:<hash>`
```

A different `project.id` yields a different workspace name, so every project gets its
own container. Callers: `src/workspace/provisioning.ts:114`,
`src/supervisor/projects/project-turn.ts:85`.

## 2. A separate global build container

`src/workspace-names.ts`: `HARNESS_BUILD_WORKSPACE_NAME = "harness-build-workspace"`,
used at `src/supervisor/artifacts/build-workspace.ts:117` via `namespace.getByName(...)`.

Under ADR-0038 the harness repository is a directory in the tenant's shared workspace,
not a globally named separate container. This name is also tenant-blind: it contains no
identity component at all.

## 3. `/project` is a fixed absolute root, defined twice

- `src/workspace/project/resolve.ts:11` — `export const PROJECT_ROOT = "/project"`
- `src/facet/generation-0/execution-env-paths.ts:12` — `export const PROJECT_ROOT = "/project"`
- `src/project-provision.ts:26-27` — `projectRoot: "/project"`, `projectGitDir: "/project/.git"`

Both constants are independent definitions of the same idea. A shared workspace needs
repository-relative directories (one per repo), so both must change together. If only
one changes, addressed-path translation and the facet's path guard silently disagree
about what is inside the sandbox — a security-relevant divergence, since
`execution-env-paths.ts:33` is the check that stops a path escaping the root.

## Why it blocks v0

Goal criterion 3: at least two GitHub repositories connected, and "one Computer
workspace contains those repositories and the separate harness repository". None of the
three encodings above permits that today.

## Scope note for T3

T3 is the largest critical-path task and it owns all three. Treat the duplicated
`PROJECT_ROOT` as one seam, not two constants: give the repository-relative root a
single owning module and let both consumers read it, or the pair will drift again.
The oracle's concurrency question also lands here — one shared container means project
turns and harness builds now share a machine, so what must serialize is an experiment
T3 must run, not a guess.
