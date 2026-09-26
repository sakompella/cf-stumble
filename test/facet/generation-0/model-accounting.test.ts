import { expect, test } from "vitest";
import {
  createModelCallAccounting,
  type ModelCallAccounting,
} from "../../../src/facet/generation-0/model-accounting.js";

function expectSummary(accounting: ModelCallAccounting) {
  expect(accounting.summary()).toEqual({
    calls: 2,
    totalMs: 15,
    completed: 1,
    failed: 1,
    aborted: 0,
  });
}

test("records each model call duration and failure outcome with a fake clock", () => {
  let now = 100;
  const accounting = createModelCallAccounting(() => now);

  const complete = accounting.start();
  now = 112;
  complete("completed");

  const fail = accounting.start();
  now = 115;
  fail("failed");

  expectSummary(accounting);
});

test("settling one call twice does not double count it", () => {
  let now = 100;
  const accounting = createModelCallAccounting(() => now);
  const finish = accounting.start();
  now = 101;
  finish("aborted");
  finish("failed");

  expect(accounting.summary()).toEqual({
    calls: 1,
    totalMs: 1,
    completed: 0,
    failed: 0,
    aborted: 1,
  });
});
