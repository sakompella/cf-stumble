import { expect, test } from "vitest";
import {
  HARNESS_PROVISION_LOCK,
  holdProvisionLock,
  provisionHarnessRepository,
} from "../src/harness-build-provision.js";
import { HARNESS_BUILD_CONFIGURATION } from "../src/harness-build.js";
import { shellQuote } from "../src/shell-quote.js";
import { WORKSPACE_ROOT } from "../src/workspace-layout.js";
import { testHarnessCommit } from "./harness-commit-fixtures.js";

// `harness-build-provision.shell.test.ts` runs the lock in real shells; this checks where it is.
test("the provision step locks a container-local file, not one Computer copies to its store", () => {
  const step = provisionHarnessRepository(
    HARNESS_BUILD_CONFIGURATION,
    testHarnessCommit("6000000000000000000000000000000000000001"),
  );

  expect(step).toContain(`lock=${shellQuote(HARNESS_PROVISION_LOCK)}\n`);
  expect(step).toContain(holdProvisionLock().join("\n"));
  expect(HARNESS_PROVISION_LOCK.startsWith(`${WORKSPACE_ROOT}/`)).toBe(false);
});
