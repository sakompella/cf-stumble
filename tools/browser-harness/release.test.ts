import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { JsonValue } from "../json.mts";
import { ANSWER_TEXT } from "./conversations.mts";
import { HARNESS_CREDENTIALS, HARNESS_PROJECT_ID } from "./fixtures.mts";
import { startHarnessServer, type HarnessServer } from "./server.mts";

const AUTHORIZATION = `Basic ${Buffer.from(
  `${HARNESS_CREDENTIALS.username}:${HARNESS_CREDENTIALS.password}`,
).toString("base64")}`;

function post(server: HarnessServer, path: string, body: JsonValue): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answered(server: HarnessServer, projectId: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (!JSON.stringify(await server.entries(projectId)).includes(ANSWER_TEXT)) {
    assert.ok(Date.now() < deadline, "the released run did not finish within 20 s");
    await sleep(20);
  }
}

test("a project whose held run was released and has finished can be disconnected", async () => {
  const server = await startHarnessServer("ready-paused");

  try {
    const path = `/api/projects/${HARNESS_PROJECT_ID}`;

    const sent = await post(server, `${path}/messages`, {
      content: "Keep working",
      requestId: "r1",
    });

    assert.equal(sent.status, 202);

    await server.waitForBarrier();
    server.release();
    await answered(server, HARNESS_PROJECT_ID);

    const disconnected = await post(server, `${path}/disconnect`, {});
    assert.equal(disconnected.status, 200, await disconnected.text());
  } finally {
    await server.close();
  }
});
