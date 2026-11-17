import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, test, vi } from "vitest";
import { subscriptions } from "../../../src/page/client/subscriptions.js";
import { Message } from "../../../src/page/client/message.js";
import { init, update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";
import { acquired } from "./views.js";
import { routeClass } from "../../../src/api/endpoints.js";
import { routePattern } from "../../../src/routes/route-pattern.js";

test("loading the page asks only for routes the Supervisor answers without the workspace container", async () => {
  const asked: string[] = [];

  vi.stubGlobal("fetch", (path: string) => {
    asked.push(path);

    return Promise.resolve(
      path.endsWith("/events")
        ? new Response('[["r",{"conversation":{},"entries":[],"docs":{}}]]\n')
        : Response.json({ ok: true, projects: [] }),
    );
  });

  const loaded = init();

  for (const command of loaded.commands ?? []) {
    await Effect.runPromise(command.effect);
  }

  const selected = update(
    loaded.model,
    Message.SucceededFetchProjects({
      projects: [
        { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
      ],
    }),
  ).model;

  const listed = update(selected, acquired(selected)).model;

  const events = subscriptions["events"];

  if (events === undefined) throw new Error("the page has no events subscription");

  await Effect.runPromise(
    openedTranscript().provide(
      events.dependenciesToStream(events.modelToDependencies(listed)).pipe(Stream.runHead),
    ),
  );

  const patterns = asked.map((path) => routePattern(path));

  expect(patterns, "the page asked something on load").not.toEqual([]);
  expect(patterns).not.toContain("/api/unknown");
  expect(patterns.map((pattern) => routeClass(pattern))).toEqual(patterns.map(() => "record-only"));
});

type Commands = NonNullable<ReturnType<typeof update>["commands"]>;

async function patternsAsked(commands: Commands): Promise<readonly string[]> {
  const asked: string[] = [];

  vi.stubGlobal("fetch", (path: string) => {
    asked.push(path);

    return Promise.resolve(Response.json({ ok: true, projects: [] }));
  });

  for (const command of commands) {
    await Effect.runPromise(openedTranscript().provide(command.effect));
  }

  return asked.map((path) => routePattern(path)).toSorted();
}

test("returning to the page asks what loading asked, and only routes the Supervisor answers without the workspace container", async () => {
  const loaded = init();
  const returned = update(loaded.model, Message.ReturnedToPage());

  const patterns = await patternsAsked(returned.commands ?? []);

  expect(patterns, "the page asked something on return").not.toEqual([]);
  expect(patterns).toEqual(await patternsAsked(loaded.commands ?? []));
  expect(patterns.map((pattern) => routeClass(pattern))).toEqual(patterns.map(() => "record-only"));
});
