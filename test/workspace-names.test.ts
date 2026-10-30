import { expect, test } from "vitest";
import { tenantWorkspaceName } from "../src/workspace-names.js";

test("refuses to name a workspace without a tenant key", () => {
  expect(() => tenantWorkspaceName("")).toThrow(
    "a tenant workspace name needs a server-derived tenant key",
  );
});
