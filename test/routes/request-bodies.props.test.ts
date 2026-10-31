import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { handleGenerationControl } from "../../src/routes/generations.js";
import { routeConversationRequest } from "../../src/routes/conversations.js";
import { messageRefusingSupervisor } from "./helpers.js";

const ORIGIN = "https://cf-stumble.test";

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

const NOT_OBJECTS = ["[]", "null", '"prompt"', "3", "not json", ""] as const;

function drawBody(tc: hegel.TestCase, names: readonly string[]): string {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
    return tc.draw(gs.sampledFrom([...NOT_OBJECTS]));
  }

  const fields = tc.draw(
    gs.arrays(gs.sampledFrom([...names, "extra", "__proto__"]), { maxSize: 4 }),
  );

  const entries = fields.map(
    (name) => `${JSON.stringify(name)}:${tc.draw(gs.sampledFrom([...FIELD_VALUES]))}`,
  );

  return `{${entries.join(",")}}`;
}

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

function admits(
  text: string,
  expected: readonly string[],
  fieldIsValid: (value: Schema.Json | undefined) => boolean,
): boolean {
  const parsed = Option.getOrUndefined(decodeJsonText(text));

  if (parsed === undefined || !isJsonObject(parsed)) return false;

  const keys = Object.keys(parsed);
  const values = new Map(Object.entries(parsed));

  return (
    keys.length === expected.length &&
    expected.every((name) => keys.includes(name) && fieldIsValid(values.get(name)))
  );
}

function post(path: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", body });
}

test("a message reaches the Supervisor exactly when its body is a string content and request id", async () => {
  await hegel.testAsync(async (tc) => {
    const names = ["content", "requestId"];
    const body = drawBody(tc, names);
    let reached = false;

    const route = routeConversationRequest(
      post("/api/projects/p/messages", body),
      messageRefusingSupervisor(() => {
        reached = true;
      }),
    );

    if (route === undefined) throw new Error("the message path must route");

    const response = await Effect.runPromise(route);
    const expected = admits(body, names, isText);

    expect(reached).toBe(expected);
    expect(response.status).toBe(expected ? 409 : 400);
  });
});

test("activation reaches the Supervisor exactly when its body is two safe non-negative integers", async () => {
  await hegel.testAsync(async (tc) => {
    const body = drawBody(tc, ["label", "observedEpoch"]);
    let reached = false;

    const response = await Effect.runPromise(
      handleGenerationControl(
        post("/api/generations/activate", body),
        {
          controlGeneration: () => {
            reached = true;

            return Promise.resolve({ ok: false, problem: { code: "stale-epoch" } });
          },
        },
        "activate",
      ),
    );

    const expected = admits(body, ["label", "observedEpoch"], isNonNegativeSafeInteger);

    expect(reached).toBe(expected);
    expect(response.status).toBe(expected ? 409 : 400);
  });
});
