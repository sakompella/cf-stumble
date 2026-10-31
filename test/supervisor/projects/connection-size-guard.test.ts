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

test("leaves the size decision to the clone, whatever GitHub's API reports", async () => {
  const subject = tenant("size-left-to-clone", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 6_000_000, default_branch: "main" },
      { truncated: true, tree: [] },
    ],
  });

  const connected = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(connected).toMatchObject({ ok: true });
  expect(
    subject.workspace.commands.filter((command) => command.includes("git clone")),
  ).toHaveLength(1);
});

test("refuses a repository the clone measures as too large, and keeps it out of the catalog", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.cloneExitCode = 122;
  const subject = tenant("size-refused-by-clone", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
  expect(listed).toEqual([HARNESS_PROJECT]);
});
