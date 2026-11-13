import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import type { HarnessLineage, WorkspaceHostRpc } from "../../src/workspace/index.js";
import {
  prepareFixtureGeneration,
  prepareGeneration,
  submitCandidate,
} from "../supervisor/helpers.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";
import { ownerApiResponse } from "./helpers.js";

const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const DROPS_ACTIVE: HarnessLineage = {
  containsActive: false,
  mainAheadOfActive: 1,
  mainAheadOfTarget: 5,
};

type OwnerStatus = Readonly<{ activeGeneration: { epoch: number }; mainAhead: number | null }>;

async function status(stub: DurableObjectStub<Supervisor>): Promise<OwnerStatus> {
  const response = await ownerApiResponse(new Request("https://cf-stumble.test/api/status"), stub);

  return response.json<OwnerStatus>();
}

async function activate(
  stub: DurableObjectStub<Supervisor>,
  label: number,
  force?: boolean,
): Promise<Response> {
  const { activeGeneration } = await status(stub);

  return ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/activate", {
      method: "POST",
      body: JSON.stringify({ label, observedEpoch: activeGeneration.epoch, force }),
    }),
    stub,
  );
}

async function withSecondGeneration(name: string) {
  const stub = env.SUPERVISOR.getByName(name);

  await activate(stub, await prepareFixtureGeneration(stub));

  const label = await submitCandidate(stub, OTHER_COMMIT);

  await prepareGeneration(stub, label, OTHER_COMMIT);

  replaceWorkspaceHost<Pick<WorkspaceHostRpc, "lineage">>(env.WORKSPACE_HOST, {
    lineage: () => Promise.resolve(DROPS_ACTIVE),
  });

  return { stub, label };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("the owner route refuses an activation that drops the active generation's commit", async () => {
  const { stub, label } = await withSecondGeneration("lineage-refused");

  const refused = await activate(stub, label);

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({
    ok: false,
    problem: { code: "drops-active-commit" },
  });
  expect((await stub.getActiveGeneration()).generation?.label).not.toBe(label);
  expect((await status(stub)).mainAhead).toBe(1);
});

test("force activates it anyway, and status reports how far main is ahead of it", async () => {
  const { stub, label } = await withSecondGeneration("lineage-forced");

  const forced = await activate(stub, label, true);

  expect(forced.status).toBe(200);
  expect((await stub.getActiveGeneration()).generation?.label).toBe(label);
  expect((await status(stub)).mainAhead).toBe(5);
});
