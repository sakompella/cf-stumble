import { expect, test } from "vitest";
import { apiResponse, apiSupervisor, decodedAnswer } from "./helpers.js";

const READS = [
  "GET /api/status",
  "GET /api/projects",
  "GET /api/github/connection",
  "GET /api/chatgpt/connection",
  "GET /api/workspace/backend",
] as const;

test.each(READS)("%s answers 200 with an answer the page decodes", async (endpoint) => {
  const response = await apiResponse(
    new Request(`https://cf-stumble.test${endpoint.slice("GET ".length)}`),
    apiSupervisor(),
  );

  expect(response.status).toBe(200);
  await expect(decodedAnswer(endpoint, response)).resolves.toBeDefined();
});

test("a workspace reset answers with an answer the page decodes", async () => {
  const response = await apiResponse(
    new Request("https://cf-stumble.test/api/workspace/reset", { method: "POST" }),
    apiSupervisor(),
  );

  expect(response.status).toBe(200);
  await expect(decodedAnswer("POST /api/workspace/reset", response)).resolves.toEqual({
    ok: true,
    reset: "workspace",
  });
});

test("an answer field the API does not define never reaches the wire", async () => {
  const response = await apiResponse(
    new Request("https://cf-stumble.test/api/chatgpt/connection"),
    apiSupervisor({
      getChatGPTConnection: () =>
        Promise.resolve({
          connection: { state: "disconnected" },
          login: null,
          model: "gpt-test",
          refreshToken: "must-not-leave",
        }),
    }),
  );

  expect(await response.json()).toEqual({
    ok: true,
    chatgpt: { connection: { state: "disconnected" }, login: null, model: "gpt-test" },
  });
});
