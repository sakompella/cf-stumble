import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { OwnerApiSupervisor } from "../../src/routes/owner-api.js";
import { ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

const ORIGIN = "https://cf-stumble.test";

const SHA = "0123456789abcdef0123".repeat(2);

type BodyRoute = Readonly<{
  path: string;
  good: Readonly<Record<string, string | number>>;
  badBodies: readonly string[];
  refusalCode: string;
  reachedStatus: number;
  supervisorReached: (reached: () => void) => Partial<OwnerApiSupervisor>;
}>;

const controlGeneration = (reached: () => void): Partial<OwnerApiSupervisor> => ({
  controlGeneration: () => {
    reached();

    return Promise.resolve({ ok: false, problem: { code: "stale-epoch" } });
  },
});

const BODY_ROUTES: readonly BodyRoute[] = [
  {
    path: "/api/projects/p/messages",
    good: { content: "hi", requestId: "r" },
    badBodies: [],
    refusalCode: "invalid-message-request",
    reachedStatus: 409,
    supervisorReached: (reached) => ({
      submitProjectMessage: () => {
        reached();

        return Promise.resolve({ ok: false, problem: { code: "workspace-busy" } });
      },
    }),
  },
  {
    path: "/api/generations/activate",
    good: { label: 1, observedEpoch: 0 },
    badBodies: ['{"label":-1,"observedEpoch":0}', '{"label":1.5,"observedEpoch":0}'],
    refusalCode: "invalid-activation-request",
    reachedStatus: 409,
    supervisorReached: controlGeneration,
  },
  {
    path: "/api/generations/rollback",
    good: { label: 1, observedEpoch: 0 },
    badBodies: ['{"label":9007199254740992,"observedEpoch":0}'],
    refusalCode: "invalid-rollback-request",
    reachedStatus: 409,
    supervisorReached: controlGeneration,
  },
  {
    path: "/api/generations/submit",
    good: { harnessCommit: SHA },
    badBodies: ['{"harnessCommit":"0123456789abcdef"}', `{"harnessCommit":"${SHA.toUpperCase()}"}`],
    refusalCode: "invalid-submission-request",
    reachedStatus: 500,
    supervisorReached: (reached) => ({
      submitGeneration: () => {
        reached();

        return Promise.reject(new Error("the submission stops here"));
      },
    }),
  },
  {
    path: "/api/projects/connect",
    good: { repositoryUrl: "https://github.com/sample/repo-1" },
    badBodies: ['{"repositoryUrl":"https://github.com/sample/repo-1","displayName":3}'],
    refusalCode: "invalid-connect-request",
    reachedStatus: 409,
    supervisorReached: (reached) => ({
      connectProject: () => {
        reached();

        return Promise.resolve({ ok: false, problem: { code: "workspace-busy", detail: "" } });
      },
    }),
  },
];

const NOT_OBJECTS = ["[]", "null", '"prompt"', "3", "not json", ""];

function badBodies(route: BodyRoute): readonly string[] {
  const names = Object.keys(route.good);

  return [
    ...NOT_OBJECTS,
    ...route.badBodies,
    ...names.map((name) => JSON.stringify({ ...route.good, [name]: null })),
    ...names.map((name) => JSON.stringify({ ...route.good, [name]: {} })),
    ...names.map((name) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(route.good).filter(([key]) => key !== name)),
      ),
    ),
    JSON.stringify({ ...route.good, extra: 1 }),
    `{${JSON.stringify(route.good).slice(1, -1)},"__proto__":{}}`,
  ];
}

function post(path: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", body });
}

async function send(
  route: BodyRoute,
  body: string,
): Promise<{ status: number; reached: boolean; json: unknown }> {
  let reached = false;

  const response = await ownerApiResponse(
    post(route.path, body),
    supervisor(
      route.supervisorReached(() => {
        reached = true;
      }),
    ),
  );

  return { status: response.status, reached, json: await response.json() };
}

test.each(BODY_ROUTES)("$path reaches the Supervisor with a good body", async (route) => {
  const result = await send(route, JSON.stringify(route.good));

  expect(result.reached).toBe(true);
  expect(result.status).toBe(route.reachedStatus);
});

test.each(BODY_ROUTES)("$path refuses each bad body before the Supervisor", async (route) => {
  for (const body of badBodies(route)) {
    const result = await send(route, body);

    expect({ body, reached: result.reached, status: result.status, json: result.json }).toEqual({
      body,
      reached: false,
      status: 400,
      json: { ok: false, error: { code: route.refusalCode } },
    });
  }
});

test("the message route hands the Supervisor its project id, content and request id unchanged", async () => {
  await hegel.testAsync(async (tc) => {
    const projectId = tc.draw(
      gs.oneOf(gs.text({ minSize: 1 }), gs.text({ alphabet: "%2541/ .-é", minSize: 1 })),
    );

    tc.assume(projectId !== "." && projectId !== "..");

    const content = tc.draw(gs.text());
    const requestId = tc.draw(gs.text());
    const received: string[] = [];

    await ownerApiResponse(
      post(
        `/api/projects/${encodeURIComponent(projectId)}/messages`,
        JSON.stringify({ content, requestId }),
      ),
      supervisor({
        submitProjectMessage: (...args) => {
          received.push(...args);

          return Promise.resolve({ ok: false, problem: { code: "workspace-busy" } });
        },
      }),
    );

    expect(received).toEqual([projectId, content, requestId]);
  });
});
