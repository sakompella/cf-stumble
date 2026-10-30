import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { routeConversationRequest } from "../../src/routes/conversations.js";
import { messageRefusingSupervisor } from "./helpers.js";

/**
 * The workerd half of `request-bodies.props.test.ts`: the edges of the exact-body rule, decoded by
 * the same runtime that serves requests.
 */

const ORIGIN = "https://cf-stumble.test";

async function messageStatus(body: string): Promise<number> {
  const route = routeConversationRequest(
    new Request(`${ORIGIN}/api/projects/p/messages`, { method: "POST", body }),
    messageRefusingSupervisor(),
  );

  if (route === undefined) throw new Error("the message path must route");

  return (await Effect.runPromise(route)).status;
}

test.each([
  ['{"content":"hi","requestId":"r"}', 409],
  ['{"content":"","requestId":""}', 409],
  ['{"content":"hi","content":"again","requestId":"r"}', 409],
  ['{"content":"hi","requestId":"r","extra":1}', 400],
  ['{"content":"hi","requestId":"r","__proto__":{}}', 400],
  ['{"__proto__":{"content":"hi","requestId":"r"}}', 400],
  ['{"content":null,"requestId":"r"}', 400],
  ['{"content":"hi"}', 400],
  ['["content"]', 400],
  ["", 400],
] as const)("the message body %s is answered %i", async (body, status) => {
  await expect(messageStatus(body)).resolves.toBe(status);
});
