import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";
import { FAKE_TOKEN, NOW, REPOSITORY, tenant } from "./connection-tenant.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test.each([
  {
    clone: "measures as too large",
    arrange: (workspace: FakeTenantWorkspace) => {
      workspace.cloneExitCode = 122;
    },
    code: "repository-too-large",
  },
  {
    clone: "fails",
    arrange: (workspace: FakeTenantWorkspace) => {
      workspace.cloneExitCode = 128;
    },
    code: "provisioning-failed",
  },
  {
    clone: "does not reach the durable store",
    arrange: (workspace: FakeTenantWorkspace) => {
      workspace.commandSync = "incomplete";
    },
    code: "provisioning-failed",
  },
])("refuses a repository whose clone $clone, and keeps it out of the catalog", async (row) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = new FakeTenantWorkspace();
  row.arrange(workspace);

  const subject = tenant(`clone-refused-${row.clone.replaceAll(" ", "-")}`, {
    workspace,
    fallbackToken: FAKE_TOKEN,
  });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: row.code } });
  expect(listed).toEqual([HARNESS_PROJECT]);
});
