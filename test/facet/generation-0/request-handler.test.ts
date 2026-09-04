import { expect, test } from "vitest";
import { handleGeneration0Request } from "../../../src/facet/generation-0/index.js";
import { FakeModelRoute, modelUnavailableReply, textReply, toolCallReply } from "./fakes.js";

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
  const capabilities = { MODEL: route };

  const first = await handleGeneration0Request(startupRequest(), capabilities);
  const second = await handleGeneration0Request(startupRequest(), capabilities);
  const body = await first.text();

  expect(first.status).toBe(200);
  expect(body).toBe("generation-0 main facet ready");
  expect(body.length, "the startup check bounds the body at 1024 bytes").toBeLessThan(1_024);
  expect(await second.text()).toBe(body);
  expect(route.requests, "the startup check must not call the model").toEqual([]);
});

/**
 * This surface has no workspace to give a turn, so a tool that needs files reports a tool error
 * the model can read and the turn still finishes with a document it can be continued from. A
 * workspace belongs to one project and this facet's environment is shared by every project the
 * generation serves, which is why the streamed `MainFacet.startTurn` takes a project capability as
 * an argument instead. `turn.test.ts` covers the tool loop with a workspace supplied directly.
 */
test("POST /turn returns the saved document and the reply, having run no command", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "run_command", arguments: { command: "check" } }]),
    textReply("I could not reach the workspace."),
  ]);

  const response = await handleGeneration0Request(
    turnRequest(JSON.stringify({ prompt: "Run the check.", document: null })),
    { MODEL: route },
  );

  const result = await response.json<{
    readonly document: string;
    readonly text: string;
    readonly commands: readonly unknown[];
  }>();

  expect(response.status).toBe(200);
  expect(result.text).toBe("I could not reach the workspace.");
  expect(result.commands, "no command can have run without a workspace").toEqual([]);
  expect(result.document).toContain("cf-stumble-generation-0");
  expect(result.document).toContain("workspace-unavailable");
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
