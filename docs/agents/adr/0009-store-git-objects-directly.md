# Store Git objects directly

The current implementation writes Git's uncompressed framed blob, tree, and commit bytes to a small content-addressed store, keyed by the SHA-1 of those exact bytes, instead of giving a filesystem to isomorphic-git. This keeps storage independent of Git's loose-object filesystem layout, but it requires a project-owned codec; the earlier claim that in-memory commits were impossible with isomorphic-git was retracted, so a replacement built on isomorphic-git directly remains open to propose now that dependency minimization is no longer a goal.

## Consequences

The codec is 614 lines of hand-rolled encoding, which is real bug surface — mitigated by checking every encode against an independent implementation, but not eliminated, and isomorphic-git is exercised across far more edge cases than this ever will be. The codec also rejects `gpgsig` and `encoding` headers by design, so it cannot read commits written by anything else; if packfiles, fetch, or push are ever wanted, the dependency returns regardless.

## Evidence

The retracted claim was checked against isomorphic-git 1.41.9: `writeTree` and `writeCommit` are publicly exported at `index.d.ts` lines 3758 and 3937, and both take an object directly with no index and no working tree. Git's own documentation (`Documentation/gitformat-loose.adoc`, `object-file.c`) confirms that Git hashes the uncompressed framed bytes and compresses only the loose-file form, so storing raw framed bytes in rows is a valid canonical representation rather than a shortcut. A prototype also established that isomorphic-git binds every `FsClient` method at construction, so a shim must provide all ten even though only four are ever called — an earlier count of four was misleading and a four-method shim failed before any call.
