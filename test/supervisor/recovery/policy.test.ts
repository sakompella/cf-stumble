import { expect, test } from "vitest";
import { validateRecoveryPolicy } from "../../../src/supervisor/recovery/index.js";

test("rejects a zero repair-attempt budget", () => {
  expect(() => {
    validateRecoveryPolicy({ maxRepairAttempts: 0, recoveryBudgetMs: 10, operationDeadlineMs: 5 });
  }).toThrow("maxRepairAttempts must be a positive safe integer");
});

test("rejects an operation deadline beyond the recovery budget", () => {
  expect(() => {
    validateRecoveryPolicy({ maxRepairAttempts: 1, recoveryBudgetMs: 5, operationDeadlineMs: 6 });
  }).toThrow("operationDeadlineMs cannot exceed recoveryBudgetMs");
});
