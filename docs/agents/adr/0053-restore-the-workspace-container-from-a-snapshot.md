# The Workspace Host restores its container from a snapshot

> **Review:** Agent-only

At an idle stop (ADR-0043) the Workspace Host saves a Cloudflare Container snapshot. It saves
one only when `/nix/store` has more entries than the last snapshot holds, and it gives a save up
after 60 seconds; a save that does not settle within the bound counts as not taken and is logged,
so an idle stop never waits on it. The next start restores that snapshot instead of booting the
bare image. A snapshot holds the container's whole
filesystem but not its processes, so the Nix store, `/root` and `/tmp` come back and the first
`nix develop` after an idle stop does not download its toolchain again. On staging the first
`nix develop -c true` of cf-stumble's flake took 16.3 s cold and 2.2 s after a restore. Code:
`src/workspace/container-snapshot.ts`, a subclass of Computer's `WorkspaceContainerAPI`.

Snapshots need the `durable_object` scheduling policy, which the stack already sets
(`infra/alchemy.run.ts`). Cloudflare docs: "Use snapshots"
(https://developers.cloudflare.com/containers/guides/snapshots/) and "Snapshot limits"
(https://developers.cloudflare.com/containers/platform/limits/#snapshot-limits).

**`/workspace` comes from the Durable Object, never from the snapshot.** The SQLite store in the
Durable Object is the only source of truth for `/workspace`. A snapshot also holds a stale copy of
`/workspace`, and computerd's VFS is in memory. A restored computerd starts with an empty VFS and
reads the stale disk as new local changes, so files deleted in the store since the stop came back
(reproduced against computerd's shim). A restore therefore starts with the entrypoint
`rm -rf /workspace && exec /usr/local/bin/computerd`. The first sync then writes the store's
state onto an empty directory, and the disk equals the store. Only restores use this entrypoint;
an image start keeps the image's entrypoint.

**One snapshot per image.** Docs: "A snapshot is tied to the Container image version it was
created from and is not portable to a different image." The record in the Host's
`storage.kv` holds the snapshot id, the value of `ctx.container.images.app` (a digest-pinned
registry reference) and the entry count. A start restores the snapshot only when its image equals
the current one; otherwise the start uses the image and deletes the record. The Host also records
the image each container launched from, and saves a snapshot only from a container that launched
from the current image, so a container that outlives a deploy is never saved. A workspace reset
deletes all Host storage, the record with it. A `restart` (failed health check) drops the record, and a restore that
throws drops it and starts from the image in the same call, so a bad snapshot is used at most
once and costs one plain start, not a failed start.

**Cost.** A save took 17.4 s of container time at the stop and stored 743 MB. Cloudflare has no
API to list or delete snapshots; each expires 30 days after its creation or its last restore. A
record older than 29 days is not restored. Saving only when the store grew bounds the count: a
workspace that only edits files saves nothing after its first snapshot, and each new toolchain
adds one. Storage pricing for snapshots is not published as of 2026-11-12. The Provider
backend (ADR-0050) does not use snapshots.
