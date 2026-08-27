# Store Git objects directly

The current implementation writes Git's uncompressed framed blob, tree, and commit bytes to a small content-addressed store, keyed by the SHA-1 of those exact bytes, instead of giving a filesystem to isomorphic-git. This keeps storage independent of Git's loose-object filesystem layout, but it requires a project-owned codec; the earlier claim that in-memory commits were impossible with isomorphic-git was retracted. ADR-0010 proposes a replacement now that dependency minimization is no longer a goal.
