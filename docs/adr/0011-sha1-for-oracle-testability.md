# Choose SHA-1 for oracle testability, not security

Object ids are the SHA-1 of Git's exact framed bytes, so an independent implementation can check every encoding this project produces and any bug shows up as a hash mismatch against a tool nobody here wrote. That is a testability argument and not a security one: the content being hashed is agent-authored, so if integrity ever becomes load-bearing the answer is to store a second SHA-256 digest alongside the real Git oid rather than to abandon Git compatibility and lose the oracle.
