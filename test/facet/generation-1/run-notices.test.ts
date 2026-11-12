import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationHost } from "../../../src/facet/index.js";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import { RUN_NOTICE_KIND } from "../../../src/run-notice.js";
import { NO_USAGE, replies, scriptedRoute } from "./scripted-route.js";

afterEach(async () => {
  await reset();
});

const host: ConversationHost & Readonly<{ dup(): ConversationHost }> = {
  arm: () => Promise.resolve(),
  log: () => Promise.resolve(),
  running: () => Promise.resolve(),
  workspace: () => Promise.reject(new Error("no workspace")),
  dup: () => host,
};

function entriesText(facet: MainFacet, id: string): Promise<string> {
  return facet.entries(id, {
    minEntryId: undefined,
    maxEntryId: undefined,
    order: "ascending",
    limit: 50,
  });
}

async function noticeCount(facet: MainFacet, id: string): Promise<number> {
  return (await entriesText(facet, id)).split(`"kind":"${RUN_NOTICE_KIND}"`).length - 1;
}

const silent = () => Promise.resolve(new ReadableStream<Uint8Array>());

const answers = replies([
  { type: "text-delta", delta: "done" },
  {
    type: "done",
    message: { role: "assistant", content: "done", tool_calls: [] },
    usage: NO_USAGE,
  },
]);

test("a reply cut off at the output limit is followed by a notice the model reads next turn", async () => {
  const cutOff = replies([
    { type: "text-delta", delta: "Here is my plan" },
    {
      type: "done",
      message: { role: "assistant", content: "Here is my plan", tool_calls: [] },
      usage: NO_USAGE,
      truncated: true,
    },
  ]);

  const { capability, requests } = scriptedRoute(cutOff, answers);

  await runInDurableObject(env.SUPERVISOR.getByName("run-notice-length"), async (_i, state) => {
    const facet = new MainFacet(state, env);

    await facet.attach(host, capability);
    const id = await facet.createConversation("/workspace");

    await facet.submit(id, "plan it", "r1");
    await vi.waitFor(async () => {
      expect(await noticeCount(facet, id)).toBe(1);
    });

    await facet.submit(id, "go on", "r2");
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]?.messages.slice(-3)).toMatchObject([
      { role: "assistant", content: "Here is my plan" },
      { role: "user" },
      { role: "user", content: "go on" },
    ]);
    expect(JSON.stringify(requests[1]?.messages.at(-2))).toContain("output length limit");
  });
});

test("a deadline abort leaves one notice however often it repeats, and an owner cancel none", async () => {
  const { capability, requests } = scriptedRoute(silent, silent);

  await runInDurableObject(env.SUPERVISOR.getByName("run-notice-deadline"), async (_i, state) => {
    const facet = new MainFacet(state, env);

    await facet.attach(host, capability);
    const cancelled = await facet.createConversation("/workspace");
    const expired = await facet.createConversation("/workspace");

    await facet.submit(cancelled, "work", "r1");
    await facet.submit(expired, "work", "r2");
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    await facet.abort(cancelled);
    await facet.abort(expired, "deadline");
    await facet.abort(expired, "deadline");

    await vi.waitFor(async () => {
      expect(await noticeCount(facet, expired)).toBe(1);
    });
    expect(await entriesText(facet, expired)).toContain("8-minute time limit");
    expect(await noticeCount(facet, cancelled)).toBe(0);
  });
});
