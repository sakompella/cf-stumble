import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import type { OwnerApiSupervisor } from "../../src/routes/owner-api.js";
import { ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

const ORIGIN = "https://cf-stumble.test";

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const FIELD_VALUES = [
  '""',
  '"text"',
  "0",
  "-0",
  "7",
  "-1",
  "1.5",
  "9007199254740992",
  "1e400",
  "null",
  "true",
  "[]",
  "{}",
] as const;

const COMMIT_VALUES = [
  `"${"0123456789abcdef0123".repeat(2)}"`,
  `"${"0123456789abcdef".repeat(4)}"`,
  `"${"0123456789ABCDEF0123".repeat(2)}"`,
  '"0123456789abcdef"',
] as const;

const URL_VALUES = ['"https://github.com/sample/repo-1"', '"not a url"'] as const;

const NOT_OBJECTS = ["[]", "null", '"prompt"', "3", "not json", ""] as const;

type Field = Readonly<{
  name: string;
  optional: boolean;
  values: readonly string[];
  isValid: (value: Schema.Json | undefined) => boolean;
}>;

type BodyRoute = Readonly<{
  path: string;
  fields: readonly Field[];
  refusalCode: string;
  reachedStatus: number;
  supervisorReached: (reached: () => void) => Partial<OwnerApiSupervisor>;
}>;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

function isJsonObject(value: Schema.Json): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: Schema.Json | undefined): value is string {
  return typeof value === "string";
}

function isNonNegativeSafeInteger(value: Schema.Json | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGitObjectId(value: Schema.Json | undefined): boolean {
  return isText(value) && GIT_OBJECT_ID.test(value);
}

const required = (
  name: string,
  isValid: Field["isValid"],
  values: readonly string[] = FIELD_VALUES,
): Field => ({ name, optional: false, values, isValid });

const counts = [
  required("label", isNonNegativeSafeInteger),
  required("observedEpoch", isNonNegativeSafeInteger),
];

const controlGeneration = (reached: () => void): Partial<OwnerApiSupervisor> => ({
  controlGeneration: () => {
    reached();

    return Promise.resolve({ ok: false, problem: { code: "stale-epoch" } });
  },
});

const BODY_ROUTES: readonly BodyRoute[] = [
  {
    path: "/api/projects/p/messages",
    fields: [required("content", isText), required("requestId", isText)],
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
    fields: counts,
    refusalCode: "invalid-activation-request",
    reachedStatus: 409,
    supervisorReached: controlGeneration,
  },
  {
    path: "/api/generations/rollback",
    fields: counts,
    refusalCode: "invalid-rollback-request",
    reachedStatus: 409,
    supervisorReached: controlGeneration,
  },
  {
    path: "/api/generations/submit",
    fields: [required("harnessCommit", isGitObjectId, [...FIELD_VALUES, ...COMMIT_VALUES])],
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
    fields: [
      required("repositoryUrl", isText, [...FIELD_VALUES, ...URL_VALUES]),
      { name: "displayName", optional: true, values: FIELD_VALUES, isValid: isText },
    ],
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

function drawBody(tc: hegel.TestCase, fields: readonly Field[]): string {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
    return tc.draw(gs.sampledFrom([...NOT_OBJECTS]));
  }

  const fieldNames = fields.map((field) => field.name);

  const names = tc.draw(gs.booleans())
    ? fieldNames
    : tc.draw(gs.arrays(gs.sampledFrom([...fieldNames, "extra", "__proto__"]), { maxSize: 4 }));

  const entries = names.map((name) => {
    const values = fields.find((field) => field.name === name)?.values ?? FIELD_VALUES;

    return `${JSON.stringify(name)}:${tc.draw(gs.sampledFrom([...values]))}`;
  });

  return `{${entries.join(",")}}`;
}

function admits(text: string, fields: readonly Field[]): boolean {
  const parsed = Option.getOrUndefined(decodeJsonText(text));

  if (parsed === undefined || !isJsonObject(parsed)) return false;

  const values = new Map(Object.entries(parsed));

  return (
    [...values.keys()].every((name) => fields.some((field) => field.name === name)) &&
    fields.every((field) => {
      const value = values.get(field.name);

      return value === undefined ? field.optional : field.isValid(value);
    })
  );
}

function post(path: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", body });
}

test("a body reaches the Supervisor exactly when it carries each required field validly and nothing else", async () => {
  await hegel.testAsync(
    async (tc) => {
      const route = tc.draw(gs.sampledFrom([...BODY_ROUTES]));
      const body = drawBody(tc, route.fields);
      let reached = false;

      const response = await ownerApiResponse(
        post(route.path, body),
        supervisor(
          route.supervisorReached(() => {
            reached = true;
          }),
        ),
      );

      const expected = admits(body, route.fields);

      expect(reached).toBe(expected);
      expect(response.status).toBe(expected ? route.reachedStatus : 400);

      if (!expected) {
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: { code: route.refusalCode },
        });
      }
    },
    { testCases: 2000 },
  );
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
