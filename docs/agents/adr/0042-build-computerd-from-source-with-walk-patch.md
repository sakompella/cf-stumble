# Build computerd from the pinned source with a shim walk patch

> **Review:** Agent-only

The workspace image builds `computerd` from Computer source commit
`9d11fa7b7f77cb8130d3f53f285ba8e0f8ea258b` (release 0.11.3) with one checked-in patch,
`infra/workspace-image/computerd-walk.patch`, instead of copying the binary out of
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:2978fc5b5ad3b2bc8429ef83e2b56079f938003ca94c3c89612f78d509d027ff`.
This changes the image half of the pins that ADR-0026 records; the source commit stays the same.

A Cloudflare container cannot mount FUSE, so computerd keeps `/workspace` in step with its store
through a userspace shim. Upstream, the shim walks the whole tree on a timer and before every
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

The patch also makes the shim's `flush` remove from disk every synced path the store no longer
has. computerd runs `flush` after it applies a push, before a container command starts, but
upstream `flush` only writes the store's entries to disk. A delete reached the disk only on the
store watcher's next tick, up to 100 ms later, so a command could still read the deleted file, and a
command that wrote to it brought the file back with its old content. The git fuzz found this on
staging (seed 1361621634): a file that an isolate `rm -rf` deleted was still in the container.
A probe on staging stage `fzgit-sldb1` (2026-11-12) saw it in 1 of 42 tries before the change and
in none of 50 after it. Release 0.11.3 (9d11fa7b, 2026-11-17) has the same `flush`, walk and
shim as 0.10.0, so the patch applies to it unchanged.

The build follows upstream's release workflow. Since 0.8.0 the binary embeds a native FUSE addon,
which the source stage compiles on Debian trixie and passes to the build through
`COMPUTERD_FUSE_ADDON`. To upgrade, move `COMPUTER_COMMIT` in `infra/workspace-image/computerd.Dockerfile`
and rebase the walk patch. Delete the walk patch and this record when an upstream release fixes
the walk and `flush`.

**Poll interval.** The patch also adds `COMPUTERD_POLL_MS` (one positive integer; unset keeps
upstream's 250 ms), and the image sets it to `5000`. The walk `lstat`s every entry outside an
ignored segment whether or not anything changed: on staging an idle computerd used about 0.1 vCPU
per 1,000 entries at 250 ms. Sync does not need the fast poll. At the pinned commit the sync RPC
reconciles the disk before every pull (`beforeFetch: () => shim.reconcileNow()`) and flushes after
every push (`afterApply: () => shim.flush()`), so every Host operation sees the disk it expects.
The poll only moves a background process's write into the store sooner; at five seconds that write
arrives up to five seconds later, for a twentieth of the idle CPU.
