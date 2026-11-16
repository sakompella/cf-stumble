import assert from "node:assert/strict";
import { it } from "node:test";
import { findingsOf } from "./git.mts";

it("a push that leaves the wrong tree on GitHub is a finding of the git fuzz run", () => {
  const findings = findingsOf(
    {
      rounds: 1,
      steps: 10,
      divergences: [],
      remoteMismatches: ["round 1: fuzz/b: oracle 1111, GitHub 2222"],
      classes: new Map(),
    },
    { area: "git", seed: 7 },
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /oracle 1111, GitHub 2222/u);
  assert.match(findings[0]?.reproduction ?? "", /--seed 7/u);
});

it("a run with no divergence and no remote mismatch has no findings", () => {
  const report = {
    rounds: 1,
    steps: 10,
    divergences: [],
    remoteMismatches: [],
    classes: new Map(),
  };

  assert.deepEqual(findingsOf(report, { area: "git", seed: 7 }), []);
});
