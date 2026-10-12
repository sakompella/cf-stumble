/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { connectedSupervisor as supervisor } from "../helpers.js";
import { abandonProjectTurn, finishProjectTurn, startProjectTurn } from "./turn-slot.js";

const NOW = 1_700_000_000_000;

const LEASE_MS = 30_000;

const PROJECT_ID = "sample-project-one";

const UNREADABLE = {
  ok: false,
  problem: {
    code: "unreadable-thread",
    projectId: PROJECT_ID,
    reason: "the stored thread is not JSON",
  },
};

async function damagedThread(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = await supervisor(name);
  await control.startFreshProjectThread(PROJECT_ID);

  await runInDurableObject(control, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE project_threads SET messages = ? WHERE project_id = ?",
      "{not json",
      PROJECT_ID,
    );
  });

  return control;
}

afterEach(async () => {
  await reset();
});

test("a damaged thread row is reported as unreadable by every read and turn step", async () => {
  const control = await damagedThread("thread-unreadable");

  expect(await control.getProjectThread(PROJECT_ID)).toStrictEqual(UNREADABLE);
  expect(await startProjectTurn(control, PROJECT_ID, 0, NOW, LEASE_MS)).toEqual(UNREADABLE);
  expect(await finishProjectTurn(control, PROJECT_ID, "lease", [], NOW)).toEqual(UNREADABLE);
  expect(await abandonProjectTurn(control, PROJECT_ID, "lease")).toEqual(UNREADABLE);
});

test("a fresh thread replaces a damaged row without reading it", async () => {
  const control = await damagedThread("thread-unreadable-fresh");

  expect(await control.startFreshProjectThread(PROJECT_ID)).toEqual({
    ok: true,
    thread: {
      projectId: PROJECT_ID,
      conversation: "[]",
      messageCount: 0,
      revision: 1,
      turnActive: false,
      turnDeadlineAt: undefined,
    },
  });
});

test("disconnecting a project whose thread is damaged reports an unknown project", async () => {
  const control = await damagedThread("thread-unreadable-disconnect");

  expect(await control.disconnectProject(PROJECT_ID)).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});
