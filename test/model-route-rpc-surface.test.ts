/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Result from "effect/Result";
import { ChatGPTCredentialStore } from "../src/chatgpt/credential-store.js";
import { loadMainFacet } from "../src/facet/index.js";

/**
 * Workers RPC exposes every method on an entrypoint's prototype, and TypeScript's `private` still
 * puts a method there. These tests reach the model route the way a generation does: a Worker
 * Loader isolate with no outbound network whose only binding is the route stub the Supervisor
 * creates.
 */

const ACCESS_TOKEN = "synthetic-access-token-for-rpc-surface";

const REFRESH_TOKEN = "synthetic-refresh-token-for-rpc-surface";

/** Reads the route's instance state and calls its helper, then answers with what came back. */
const PROBING_GENERATION = `
const seen = [];

async function probe(read) {
  try {
    const value = await read();
    const access = typeof value?.access === "function" ? await value.access() : undefined;
    seen.push(JSON.stringify({ value, access }) ?? "");
    return "answered";
  } catch (error) {
    seen.push(String(error));
    return "refused";
  }
}

export default {
  async fetch(_request, env) {
    const outcomes = {
      chatgptCredential: await probe(() => env.MODEL.chatgptCredential()),
      ctx: await probe(() => env.MODEL.ctx),
      env: await probe(() => env.MODEL.env),
    };
    return Response.json({ outcomes, seen });
  },
};
`;

afterEach(async () => {
  await reset();
});

test("a generation holding the model route cannot reach its credential helper or instance state", async () => {
  const supervisor = "rpc-surface-credential-holder";

  await runInDurableObject(env.SUPERVISOR.getByName(supervisor), (_instance, state) => {
    new ChatGPTCredentialStore(state.storage).connect(
      {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: Date.now() + 3_600_000,
        clientId: "synthetic-client",
      },
      Date.now(),
    );
  });

  const loaded = loadMainFacet(
    env.LOADER,
    {
      harnessCommit: "fe00456789abcdef0123456789abcdef01234567",
      entryModule: "main.js",
      modules: [{ name: "main.js", source: PROBING_GENERATION }],
    },
    { MODEL: workerExports.ModelRoute({ props: { supervisor } }) },
  );

  if (Result.isFailure(loaded)) throw new Error("the probing generation must load");

  const response = await loaded.success.worker
    .getEntrypoint()
    .fetch(new Request("https://cf-stumble.test/"));

  const body = await response.text();

  expect(body).not.toContain(ACCESS_TOKEN);
  expect(body).not.toContain(REFRESH_TOKEN);
  expect(JSON.parse(body)).toMatchObject({
    outcomes: { chatgptCredential: "refused", ctx: "refused", env: "refused" },
  });
});
