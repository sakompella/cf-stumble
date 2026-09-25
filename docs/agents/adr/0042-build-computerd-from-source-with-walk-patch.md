# Build computerd from the pinned source with a shim walk patch

> **Review:** Agent-only

The workspace image builds `computerd` from Computer source commit
`12336475c9fd03f5280a4537a707797fc0131fbd` with one checked-in patch,
`containers/computerd-walk.patch`, instead of copying the binary out of
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`.
This changes the image half of the pair that ADR-0026 pins; the source commit stays the same.

A Cloudflare container cannot mount FUSE, so computerd keeps `/workspace` in step with its store
through a userspace shim. Upstream, the shim walks the whole tree every 250 ms and before every
workspace pull, and its walk follows symlinks. After one `npm install` in a project, every
deployed workspace operation took minutes, both with `node_modules` in the project and with
`node_modules` as a symlink into `/tmp`. The `ignore` list cf-stumble sends with each pull keeps
those files out of the Workspace Host's SQLite, but the walk happens before the filter runs.
Instructions that ask the model to install elsewhere were not followed.

The patch makes the shim use `lstat`, sync a symlink as a symlink, and skip every path with a
segment in `COMPUTERD_WALK_IGNORE` in both directions. The image sets that variable to the same
list as `WORKSPACE_SYNC_IGNORES`, and a test checks that the two agree. Files under an ignored
segment therefore exist only in the container: they are not durable and a container restart
loses them.

The build follows upstream's release workflow, and its `computerd-upstream` stage builds the same
commit without the patch and checks that the result is byte-identical to the published binary.
To upgrade, move the commit, check the reproduction, and re-apply the patch, as the Dockerfile
header describes. Delete the patch and this record when an upstream release fixes the walk.
