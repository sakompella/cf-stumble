import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { routeProjectTurnRequest } from "../../src/routes/turns.js";

/**
 * The workerd half of `request-bodies.props.test.ts`: the edges of the exact-body rule, decoded by
 * the same runtime that serves requests.
 */

const ORIGIN = "https://cf-stumble.test";

async function turnStatus(body: string): Promise<number> {
  const route = routeProjectTurnRequest(
    new Request(`${ORIGIN}/api/projects/p/turn`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body,
    }),
    {
      runProjectTurn: () => Promise.resolve({ ok: false, problem: { code: "turn-conflict" } }),
    },
  );

  if (route === undefined) throw new Error("the turn path must route");

  return (await Effect.runPromise(route)).status;
}

test.each([
  ['{"prompt":"hi"}', 409],
  ['{"prompt":""}', 409],
  ['{"prompt":"hi","prompt":"again"}', 409],
  ['{"prompt":"hi","extra":1}', 400],
  ['{"prompt":"hi","__proto__":{}}', 400],
  ['{"__proto__":{"prompt":"hi"}}', 400],
  ['{"prompt":null}', 400],
  ['["prompt"]', 400],
  ["", 400],
] as const)("the turn body %s is answered %i", async (body, status) => {
  await expect(turnStatus(body)).resolves.toBe(status);
});
