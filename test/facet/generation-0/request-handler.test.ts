import { expect, test } from "vitest";
import { handleGeneration0Request } from "../../../src/facet/generation-0/index.js";
import {
  FakeModelRoute,
  FakeWorkspace,
  modelUnavailableReply,
  textReply,
  toolCallReply,
} from "./fakes.js";

const CHECK_OUTPUT = { stdout: "ok\n", stderr: "", exitCode: 0 } as const;

function turnRequest(body: string): Request {
  return new Request("https://main-facet.invalid/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function startupRequest(): Request {
  return new Request("https://main-facet.invalid/");
}

test("GET / answers cheaply and deterministically without using a capability", async () => {
  const route = new FakeModelRoute([]);
  const workspace = new FakeWorkspace();
  const capabilities = { MODEL: route, WORKSPACE: workspace };

  const first = await handleGeneration0Request(startupRequest(), capabilities);
  const second = await handleGeneration0Request(startupRequest(), capabilities);
  const body = await first.text();

  expect(first.status).toBe(200);
  expect(body).toBe("generation-0 main facet ready");
  expect(body.length, "the startup check bounds the body at 1024 bytes").toBeLessThan(1_024);
  expect(await second.text()).toBe(body);
  expect(route.requests, "the startup check must not call the model").toEqual([]);
  expect(workspace.requests, "the startup check must not call the workspace").toEqual([]);
});

test("POST /turn returns the saved document, the reply, and the commands it ran", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "run_command", arguments: { command: "check" } }]),
    textReply("The check passed."),
  ]);
  const workspace = new FakeWorkspace({ commands: { check: CHECK_OUTPUT } });

  const response = await handleGeneration0Request(
    turnRequest(JSON.stringify({ prompt: "Run the check.", document: null })),
    { MODEL: route, WORKSPACE: workspace },
  );

  const result = await response.json<{
    readonly document: string;
    readonly text: string;
    readonly commands: readonly unknown[];
  }>();

  expect(response.status).toBe(200);
  expect(result.text).toBe("The check passed.");
  expect(result.commands).toEqual([{ command: "check", ...CHECK_OUTPUT }]);
  expect(result.document).toContain("cf-stumble-generation-0");
});

test("rejects a malformed turn request and a document from another generation", async () => {
  const route = new FakeModelRoute([]);
  const capabilities = { MODEL: route };

  for (const body of [
    "not json",
    "[]",
    JSON.stringify({ document: null }),
    JSON.stringify({ prompt: 1 }),
  ]) {
    const response = await handleGeneration0Request(turnRequest(body), capabilities);
    expect(response.status).toBe(400);
  }

  const stale = await handleGeneration0Request(
    turnRequest(JSON.stringify({ prompt: "Continue.", document: '{"turns":[]}' })),
    capabilities,
  );
  expect(stale.status).toBe(400);
  expect(await stale.json()).toEqual({ error: { code: "invalid-session-document" } });
  expect(route.requests).toEqual([]);
});

test("reports a model outage as a failed turn", async () => {
  const response = await handleGeneration0Request(
    turnRequest(JSON.stringify({ prompt: "Hello.", document: null })),
    { MODEL: new FakeModelRoute([modelUnavailableReply]) },
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { code: "model-unavailable" } });
});

test("answers nothing else, and only POST on the turn path", async () => {
  const capabilities = { MODEL: new FakeModelRoute([]) };

  const unknown = await handleGeneration0Request(
    new Request("https://main-facet.invalid/facet/model"),
    capabilities,
  );
  const wrongMethod = await handleGeneration0Request(
    new Request("https://main-facet.invalid/turn"),
    capabilities,
  );

  expect(unknown.status).toBe(404);
  expect(wrongMethod.status).toBe(405);
});
