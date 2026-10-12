// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The oracle restates the body rule over raw JSON, so it reads unparsed values on purpose.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { handleGenerationControl } from "../../src/routes/generations.js";
import { routeProjectTurnRequest } from "../../src/routes/turns.js";

/**
 * A request body must be a JSON object with exactly the fields its route names, each of the right
 * type. These properties draw bodies from field names and values that sit on every edge of that
 * rule, and check that a route reaches the Supervisor exactly when the rule admits the body.
 */

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

/** One body as JSON text, so a key such as `__proto__` stays an ordinary own field. */
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

/** The rule itself, over the parsed body. */
function admits(
  text: string,
  expected: readonly string[],
  fieldIsValid: (name: string, value: unknown) => boolean,
): boolean {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

  const keys = Object.keys(parsed);
  const values = new Map(Object.entries(parsed));

  return (
    keys.length === expected.length &&
    expected.every((name) => keys.includes(name) && fieldIsValid(name, values.get(name)))
  );
}

function post(path: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN }, body });
}

test("a turn reaches the Supervisor exactly when its body is one string prompt", async () => {
  await hegel.testAsync(async (tc) => {
    const body = drawBody(tc, ["prompt"]);
    let reached = false;

    const route = routeProjectTurnRequest(post("/api/projects/p/turn", body), {
      runProjectTurn: () => {
        reached = true;

        return Promise.resolve({ ok: false, problem: { code: "turn-conflict" } });
      },
    });

    if (route === undefined) throw new Error("the turn path must route");

    const response = await Effect.runPromise(route);
    const expected = admits(body, ["prompt"], (_name, value) => typeof value === "string");

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

    const expected = admits(
      body,
      ["label", "observedEpoch"],
      (_name, value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    );

    expect(reached).toBe(expected);
    expect(response.status).toBe(expected ? 200 : 400);
  });
});
