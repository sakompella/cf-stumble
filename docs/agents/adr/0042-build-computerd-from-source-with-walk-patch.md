# Build computerd from the pinned source with a shim walk patch

> **Review:** Agent-only

The workspace image builds `computerd` from Computer source commit
`9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1` (release 0.8.0) with one checked-in patch,
`containers/computerd-walk.patch`, instead of copying the binary out of
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:de6f3727a12c8adb2f8ece853105ccc461fef02f90e368fac4e0578eacc461aa`.
This changes the image half of the pins that ADR-0026 records; the source commit stays the same.

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

The build follows upstream's release workflow. Since 0.8.0 the binary embeds a native FUSE addon,
which the source stage compiles on Debian trixie and passes to the build through
`COMPUTERD_FUSE_ADDON`. To upgrade, move `COMPUTER_COMMIT` in `containers/computerd.Dockerfile`
and rebase the walk patch. Delete the walk patch and this record when an upstream release fixes
the walk.

ADR-0044 changes how often the shim walks the disk: it no longer polls every 250 ms.
