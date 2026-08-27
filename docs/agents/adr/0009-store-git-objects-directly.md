# Store Git objects directly

The implementation writes Git's uncompressed framed blob, tree, and commit bytes to a small content-addressed store, keyed by the SHA-1 of those exact bytes, rather than giving isomorphic-git a filesystem. That keeps storage independent of Git's loose-object filesystem layout, but requires a project-owned codec. We retracted the earlier claim that isomorphic-git could not make commits in memory, so a replacement built directly on isomorphic-git is open for proposal now that dependency minimization is no longer a goal.

## Consequences

The codec is 614 lines of hand-rolled encoding. Checking every encoding against an independent implementation reduces that bug surface but does not remove it, and isomorphic-git has seen far more edge cases than this codec will. The codec also rejects `gpgsig` and `encoding` headers by design, so it cannot read commits written by anything else. If we need packfiles, fetch, or push, the dependency returns regardless.

## Evidence

We checked the retracted claim against isomorphic-git 1.41.9: `writeTree` and `writeCommit` are publicly exported at `index.d.ts` lines 3758 and 3937, and both take an object directly with no index or working tree. Git's own documentation (`Documentation/gitformat-loose.adoc`, `object-file.c`) confirms that Git hashes uncompressed framed bytes and compresses only the loose-file form, so raw framed bytes in rows are a canonical representation, not a shortcut. A prototype also found that isomorphic-git binds every `FsClient` method at construction, so a shim must provide all ten even though only four are called. The earlier count of four was misleading: a four-method shim failed before any call.
