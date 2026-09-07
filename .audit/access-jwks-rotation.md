# Access JWKS rotation defect

1. Reproduce the pinned-key failure with the current Access boundary and identify the surviving cause.
2. Plan the smallest boundary key-source change without changing the pure verification core contract.
3. Implement JWKS loading, bounded in-memory caching, and unknown-`kid` refresh.
4. Add injected-fetch tests for cache hit, rotation, fetch failure, malformed JWKS, and token secrecy.
5. Run `pnpm verify` and inspect the final diff without committing.
6. skip: Opening a PR is not requested and commits are forbidden.
