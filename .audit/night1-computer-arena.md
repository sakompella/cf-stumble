# Night 1 Computer vendoring arena

1. Frame. Produce a Computer vendoring design that preserves ADR-0026, keeps one pin source, produces a Worker-importable package, and gives reviewers a rerunnable drift check.
2. Fan out. Four read-only candidates inspect the pinned Computer source assumptions and the current Pi vendoring pattern.
3. Cross-judge. Opus scores candidates on correctness, maintenance cost, package closure, reproducibility, and fit with the repository.
4. Pick. Select the smallest design that handles unpublished internal packages without broad shims.
5. Graft. Add only stronger checks or packaging details that fit the selected design.
6. Verify. The implementation worker must make the vendor check fail after a deliberate byte change, pass after restoration, build the package, and pass `pnpm verify`.
