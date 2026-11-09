import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, expect, test, vi } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";
import { whoShown } from "./shown.js";
import { received, viewing } from "./views.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const transcript = openedTranscript();

const sentBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ requestId: Schema.String })),
);

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
];

function sendingPage(): UpdateResult {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const ready = update(listed, received(listed, viewing())).model;
  const typed = update(ready, Message.UpdatedPrompt({ value: "do it" })).model;
  const clicked = update(typed, Message.ClickedSendTurn()).model;

  return update(
    clicked,
    Message.MintedRequestId({ projectId: "repo", requestId: "r1", content: "do it" }),
  );
}

type UpdateResult = ReturnType<typeof update>;

async function settled(
  { model, commands }: UpdateResult,
  answer: () => Response,
): Promise<{ model: Model; requestIds: readonly string[] }> {
  const requestIds: string[] = [];

  vi.stubGlobal("fetch", (_path: string, request?: RequestInit) => {
    requestIds.push(sentBody(request?.body).requestId);

    return Promise.resolve(answer());
  });

  let next = model;

  for (const command of commands ?? []) {
    next = update(next, await Effect.runPromise(transcript.provide(command.effect))).model;
  }

  return { model: next, requestIds };
}

const problem = (code: string, status: number) => () =>
  Response.json({ ok: false, problem: { code } }, { status });

test("a send the Worker answers with 503 stays in the conversation as not confirmed, and retrying posts the same request id", async () => {
  const lost = await settled(sendingPage(), problem("generation-failed", 503));

  expect(whoShown(lost.model)).toEqual(["Unconfirmed"]);
  expect(lost.model.prompt).toBe("");

  const retried = await settled(
    update(lost.model, Message.ClickedRetrySend({ requestId: "r1" })),
    () => Response.json({ ok: true, submissionId: 7 }, { status: 202 }),
  );

  expect(retried.requestIds).toEqual(["r1"]);
  expect(whoShown(retried.model)).toEqual(["you · queued"]);
});

test("a send the Worker refuses with 4xx comes back to the prompt and cannot be retried", async () => {
  const refused = await settled(sendingPage(), problem("workspace-busy", 409));

  expect(whoShown(refused.model)).toEqual([]);
  expect(refused.model.prompt).toBe("do it");
  expect(
    update(refused.model, Message.ClickedRetrySend({ requestId: "r1" })).commands ?? [],
  ).toEqual([]);
});

test("a send that never got an answer is not confirmed either", async () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

  const { model, commands } = sendingPage();

  const failed = update(
    model,
    await Effect.runPromise(transcript.provide((commands ?? [])[0]!.effect)),
  ).model;

  expect(whoShown(failed)).toEqual(["Unconfirmed"]);
  expect(failed.pageError).toContain("offline");
});
