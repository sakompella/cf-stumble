# Store Git objects directly

The current implementation writes Git's uncompressed framed blob, tree, and commit bytes to a small content-addressed store, keyed by the SHA-1 of those exact bytes, instead of giving a filesystem to isomorphic-git. This keeps storage independent of Git's loose-object filesystem layout, but it requires a project-owned codec; the earlier claim that in-memory commits were impossible with isomorphic-git was retracted. ADR-0010 proposes a replacement now that dependency minimization is no longer a goal.

## Consequences

The codec is 614 lines of hand-rolled encoding, which is real bug surface — mitigated by checking every encode against an independent implementation, but not eliminated, and isomorphic-git is exercised across far more edge cases than this ever will be. The codec also rejects `gpgsig` and `encoding` headers by design, so it cannot read commits written by anything else; if packfiles, fetch, or push are ever wanted, the dependency returns regardless.
