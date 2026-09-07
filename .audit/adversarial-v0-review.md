# Adversarial v0 review

## Investigation

1. [ ] Route through the how skill in Critique mode.
2. [x] throughput checkpoint: n/a, read-only investigation
3. [ ] Produce the how-shaped explanation and adversarial recommendation.
4. [ ] Apply the unslop skill to the reply.

## Review phases

1. [x] Frame
   - Review landed changes from `48544ef` through `79a9207`.
   - Review the isolated Unit 4B candidate from `79a9207` through `4146393`.
   - Find correctness, security, lifecycle, boundary, and false-evidence defects.
2. [ ] Fan out
3. [ ] Aggregate
4. [ ] Report

## Intent

The landed changes enforce one Access owner, export the Pi runtime pieces needed by generated code,
and expose one project through a narrow Computer-backed RPC capability. The Unit 4B candidate adds
a facet-local Pi `ExecutionEnv`, byte-framed command events, and a real Worker Loader test that runs
Pi's stock tools through a `ProjectRpcTarget`. The review must decide whether these changes are safe
to merge and build on. It must not treat a passing verifier as sufficient evidence.
