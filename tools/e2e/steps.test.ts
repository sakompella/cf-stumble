import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Skip, Steps } from "./steps.mts";

const MINUTE = 60_000;

describe("a step's outcome", () => {
  it("is a failure when the work throws an error whose message is empty", async () => {
    const steps = new Steps();

    assert.equal(
      await steps.run("empty message", MINUTE, () => Promise.reject(new Error(""))),
      false,
    );
    assert.equal(steps.report("steps"), false);
  });

  it("passes when the work finishes, and a skip with no reason does not fail the run", async () => {
    const steps = new Steps();

    assert.equal(await steps.run("finishes", MINUTE, () => Promise.resolve()), true);
    assert.equal(await steps.run("skipped", MINUTE, () => Promise.reject(new Skip(""))), true);
    assert.equal(steps.report("steps"), true);
  });
});
