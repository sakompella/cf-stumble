import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");

describe("the automatic production deploy refuses a stale SHA", () => {
  it("guards the workflow_run path against a target SHA that is no longer main's tip", () => {
    const checkout = workflow.indexOf("actions/checkout@v7");
    const guarded = workflow.indexOf("if: github.event_name == 'workflow_run'");
    const deploy = workflow.indexOf('pnpm run deploy "$STAGE" --yes');

    assert.ok(checkout !== -1 && deploy !== -1, "the deploy job must keep its checkout and deploy");

    assert.ok(
      guarded > checkout && guarded < deploy,
      "the freshness guard must run after checkout and before the deploy",
    );

    const guard = workflow.slice(checkout, deploy);

    assert.match(guard, /git ls-remote origin refs\/heads\/main/u);
    assert.match(guard, /TARGET_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
    assert.match(guard, /"\$tip" != "\$TARGET_SHA"/u);
  });
});
