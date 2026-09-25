import { expect, test } from "vitest";
import { PROJECT_TURN_DEADLINE_MS, PROJECT_TURN_LEASE_MS } from "../src/turn-budget.js";

test("keeps the turn deadline below its longer lease", () => {
  expect(PROJECT_TURN_LEASE_MS).toBeGreaterThan(PROJECT_TURN_DEADLINE_MS);
});
