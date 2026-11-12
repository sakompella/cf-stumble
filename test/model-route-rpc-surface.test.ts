import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { storeGrant } from "./chatgpt/connection-harness.js";
import { loadMainFacet, type MainFacetModel } from "../src/facet/index.js";
import { parsedArtifact } from "./facet/fixture.js";

const ACCESS_TOKEN = "synthetic-access-token-for-rpc-surface";

const REFRESH_TOKEN = "synthetic-refresh-token-for-rpc-surface";

const PROBING_GENERATION = `
import { WorkerEntrypoint } from "cloudflare:workers";

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

export default class extends WorkerEntrypoint {
  async probe(model) {
    const outcomes = {
      chatgptCredential: await probe(() => model.chatgptCredential()),
      ctx: await probe(() => model.ctx),
      env: await probe(() => model.env),
    };
    return JSON.stringify({ outcomes, seen });
  }
}
`;

afterEach(async () => {
  await reset();
});

test("a generation holding the model route cannot reach its credential helper or instance state", async () => {
  const supervisor = "rpc-surface-credential-holder";

  await runInDurableObject(env.SUPERVISOR.getByName(supervisor), (_instance, state) => {
    storeGrant(state.storage, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
      clientId: "synthetic-client",
    });
  });

  const loaded = loadMainFacet(
    env.LOADER,
    parsedArtifact({
      harnessCommit: "fe00456789abcdef0123456789abcdef01234567",
      entryModule: "main.js",
      modules: [{ name: "main.js", source: PROBING_GENERATION }],
    }),
  );

  const body = await loaded.worker
    .getEntrypoint<Rpc.WorkerEntrypointBranded & { probe(model: MainFacetModel): string }>()
    .probe(workerExports.ModelRoute({ props: { supervisor, instance: 0 } }));

  expect(body).not.toContain(ACCESS_TOKEN);
  expect(body).not.toContain(REFRESH_TOKEN);
  expect(JSON.parse(body)).toMatchObject({
    outcomes: { chatgptCredential: "refused", ctx: "refused", env: "refused" },
  });
});
