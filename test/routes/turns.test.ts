import { afterEach, expect, test, vi } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { ownerApiSupervisor as supervisor, ownerScope } from "./helpers.js";
import { sampleProjectOne } from "../project-fixtures.js";
import type { ProjectTurnRunProblemCode } from "../../src/supervisor/projects/index.js";

/**
 * The turn route at the HTTP boundary: `POST /api/projects/{id}/turn`.
 *
 * The Worker verifies Access and derives the Supervisor before any of this runs, so what is left
 * to hold here is what a request may carry, where a refusal lands as a status, and that nothing a
 * failure returns describes what went wrong inside the Supervisor.
 */

const ORIGIN = "https://cf-stumble.test";

const TURN_PATH = `/api/projects/${sampleProjectOne.id}/turn`;

const SECRET = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

afterEach(() => {
  vi.restoreAllMocks();
});

type TurnBody = Readonly<{
  prompt?: string | number;
  tenant?: string;
  state?: readonly unknown[];
  messages?: readonly unknown[];
  leaseId?: string;
  model?: string;
}>;

function post(path: string, body: TurnBody | string, origin: string | undefined = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: origin === undefined ? {} : { origin },
    body: JSON.stringify(body),
  });
}

/** A Supervisor whose turn answers one frame and closes, so a test can read the whole body. */
function streamingSupervisor(sent: unknown[]) {
  return supervisor({
    runProjectTurn: (projectId, prompt) => {
      sent.push(projectId, prompt);

      return Promise.resolve({
        ok: true,
        frames: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"kind":"text","text":"working"}\n'));
            controller.close();
          },
        }),
      });
    },
  });
}

test("runs the turn the path names with the prompt the body carries, and nothing else", async () => {
  const sent: unknown[] = [];

  const response = await routeOwnerApiRequest(
    post(TURN_PATH, { prompt: "read the file" }),
    streamingSupervisor(sent),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(sent).toEqual([sampleProjectOne.id, "read the file"]);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  await expect(response.text()).resolves.toBe('{"kind":"text","text":"working"}\n');
});

test.each([
  [{ prompt: 7 }],
  [{}],
  [{ prompt: "do it", tenant: "someone-else" }],
  [{ prompt: "do it", messages: [{ role: "user" }] }],
  [{ prompt: "do it", leaseId: "lease-of-my-own" }],
  [{ prompt: "do it", model: "some-other-model" }],
  ["not an object"],
])("refuses the turn body %j before the Supervisor sees it", async (body) => {
  const reached: unknown[] = [];

  const response = await routeOwnerApiRequest(
    post(TURN_PATH, body),
    supervisor({
      runProjectTurn: (projectId) => {
        reached.push(projectId);

        return Promise.reject(new Error("this body must not reach the Supervisor"));
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(400);
  expect(reached).toEqual([]);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "invalid-turn-request" },
  });
});

test.each([
  ["invalid-prompt", 400],
  ["invalid-project-id", 400],
  ["unknown-project-id", 404],
  ["turn-conflict", 409],
  ["stale-revision", 409],
  ["unreadable-thread", 500],
  ["no-active-generation", 503],
  ["mount-failed", 503],
  ["workspace-unavailable", 503],
  ["turn-not-started", 503],
] as const satisfies readonly (readonly [ProjectTurnRunProblemCode, number])[])(
  "answers a %s refusal with %i",
  async (code, status) => {
    const response = await routeOwnerApiRequest(
      post(TURN_PATH, { prompt: "do it" }),
      supervisor({ runProjectTurn: () => Promise.resolve({ ok: false, problem: { code } }) }),
      ownerScope,
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
  },
);

test("a turn that throws logs a redacted cause and answers a bare fault", async () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await routeOwnerApiRequest(
    post(TURN_PATH, { prompt: "do it" }),
    supervisor({
      runProjectTurn: () =>
        Promise.reject(new Error(`container timed out with ${SECRET} in /root/.git-credentials`)),
    }),
    ownerScope,
  );

  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ ok: false, error: { code: "internal-error" } });
  expect(body).not.toContain(SECRET);
  expect(body).not.toContain("git-credentials");
  expect(loggedErrors).toHaveBeenCalledOnce();
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("internal-error");
  expect(logged).not.toContain(SECRET);
});

test("the turn route keeps to its method and its path", async () => {
  const sent: unknown[] = [];

  const read = await routeOwnerApiRequest(
    new Request(`${ORIGIN}${TURN_PATH}`),
    streamingSupervisor(sent),
    ownerScope,
  );

  const nested = await routeOwnerApiRequest(
    post(`/api/projects/${sampleProjectOne.id}/turn/fresh`, { prompt: "do it" }),
    streamingSupervisor(sent),
    ownerScope,
  );

  expect([read.status, nested.status]).toEqual([404, 404]);
  expect(sent).toEqual([]);
});

test("the project id in the path reaches the Supervisor as the client wrote it", async () => {
  const sent: unknown[] = [];

  const response = await routeOwnerApiRequest(
    post("/api/projects/no%20such%20project/turn", { prompt: "do it" }),
    supervisor({
      runProjectTurn: (projectId, prompt) => {
        sent.push(projectId, prompt);

        return Promise.resolve({ ok: false, problem: { code: "unknown-project-id" } });
      },
    }),
    ownerScope,
  );

  // The route decodes the path segment and refuses an empty one; deciding whether the string is a
  // project stays with the catalog, which is the only thing that knows.
  expect(sent).toEqual(["no such project", "do it"]);
  expect(response.status).toBe(404);
});
