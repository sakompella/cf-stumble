import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, expect, test, vi } from "vitest";
import { subscriptions } from "../../../src/page/client/events-stream.js";
import { Message } from "../../../src/page/client/message.js";
import { init, update } from "../../../src/page/client/update.js";
import { routeClass, routePattern } from "../../../src/routes/route-pattern.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("loading the page asks only for routes the Supervisor answers without the workspace container", async () => {
  const asked: string[] = [];

  vi.stubGlobal("fetch", (path: string) => {
    asked.push(path);

    return Promise.resolve(
      path.endsWith("/events")
        ? new Response('{"type":"snapshot","entries":[],"tools":[],"inbox":[]}\n')
        : Response.json({ ok: true, projects: [] }),
    );
  });

  const loaded = init();

  for (const command of loaded.commands ?? []) {
    await Effect.runPromise(command.effect);
  }

  const listed = update(
    loaded.model,
    Message.SucceededFetchProjects({
      projects: [
        { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
      ],
    }),
  ).model;

  const events = subscriptions["events"];

  if (events === undefined) throw new Error("the page has no events subscription");

  await Effect.runPromise(
    events.dependenciesToStream(events.modelToDependencies(listed)).pipe(Stream.runHead),
  );

  const patterns = asked.map((path) => routePattern(path));

  expect(patterns, "the page asked something on load").not.toEqual([]);
  expect(patterns).not.toContain("/api/unknown");
  expect(patterns.map((pattern) => routeClass(pattern))).toEqual(patterns.map(() => "record-only"));
});
