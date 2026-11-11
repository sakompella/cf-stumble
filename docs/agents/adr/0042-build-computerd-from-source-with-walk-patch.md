# Build computerd from the pinned source with a shim walk patch

> **Review:** Agent-only

The workspace image builds `computerd` from Computer source commit
`bb0a5db4b7e8c8a79625d63e0e272602f909640e` (release 0.10.0) with one checked-in patch,
`infra/workspace-image/computerd-walk.patch`, instead of copying the binary out of
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:6ec793fa80f109acf8b3cd4e295284cfed97f61c03030b780a612ec22c49b294`.
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
list as `WORKSPACE_SYNC_IGNORES`, and a test checks that the two agree. The list holds
`node_modules` and `.venv`. A Python virtual environment is the same kind of tree as
`node_modules`: a local run with numpy, pandas, django and matplotlib (8,272 files, 194 MB) took
31 s for the first pull after the install and 3 to 6 s for each pull in the next 25 s, and
ignoring `.venv` brought both to a few milliseconds. No deployed project has produced this yet.
Files under an ignored segment therefore exist only in the container: they are not durable and a
container restart loses them. A segment matches at any depth, so a nested `.venv` is ignored the
same way as a nested `node_modules`.

The build follows upstream's release workflow. Since 0.8.0 the binary embeds a native FUSE addon,
which the source stage compiles on Debian trixie and passes to the build through
`COMPUTERD_FUSE_ADDON`. To upgrade, move `COMPUTER_COMMIT` in `infra/workspace-image/computerd.Dockerfile`
and rebase the walk patch. Delete the walk patch and this record when an upstream release fixes
the walk.

ADR-0044 changes how often the shim walks the disk: it no longer polls every 250 ms.
