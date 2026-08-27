# Choose SHA-1 for oracle testability, not security

Object ids are the SHA-1 of Git's exact framed bytes, so an independent implementation can check every encoding this project produces. Any bug becomes a hash mismatch against a tool nobody here wrote. This is a testability argument, not a security argument: the hashed content is agent-authored, so if we must protect its integrity, store a second SHA-256 digest beside the real Git oid rather than abandon Git compatibility and lose the oracle.

## Evidence

The oracle runs inside workerd, so it tests the runtime this project deploys to. A probe of isomorphic-git under workerd produced `ce013625…` for `"hello\n"`, exactly matching the real `git` binary.
