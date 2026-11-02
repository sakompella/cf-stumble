import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { routeConversationRequest } from "../../src/routes/conversations.js";
import { messageRefusingSupervisor } from "./helpers.js";

test("a message body that nests its fields under __proto__ is refused", async () => {
  const route = routeConversationRequest(
    new Request("https://cf-stumble.test/api/projects/p/messages", {
      method: "POST",
      body: '{"__proto__":{"content":"hi","requestId":"r"}}',
    }),
    messageRefusingSupervisor(),
  );

  if (route === undefined) throw new Error("the message path must route");

  expect((await Effect.runPromise(route)).status).toBe(400);
});
