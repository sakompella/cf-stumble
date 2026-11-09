import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { GenerationHistory } from "../../../src/supervisor/history/log.js";
import { r2History } from "../../../src/supervisor/history/r2-history.js";

afterEach(async () => {
  await reset();
});

async function putStored(key: string, value: Parameters<R2Bucket["put"]>[1]): Promise<R2Object> {
  const object = await env.MODULE_MAPS.put(key, value);

  if (object === null) throw new Error("the unconditional put stored nothing");

  return object;
}

function bucketWhereSlowPutLandsLate() {
  const landed: Promise<unknown>[] = [];

  const bucket: R2Bucket = {
    ...env.MODULE_MAPS,
    put(key, value) {
      if (key.endsWith("refused.json")) return Promise.reject(new Error("the bucket refused"));

      if (value !== "older") return putStored(key, value);

      const slow = new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      }).then(() => putStored(key, value));

      landed.push(slow);

      return slow;
    },
  };

  return { landed, bucket };
}

test("a newer history commit is not written until every put of the failed older commit has settled", async () => {
  const { landed, bucket } = bucketWhereSlowPutLandsLate();
  const pending: Promise<void>[] = [];

  const history = new GenerationHistory(
    r2History(bucket),
    (promise) => {
      pending.push(promise);
    },
    () => 1,
  );

  history.commit({
    message: "older",
    files: { "generations/0.json": "older", "generations/refused.json": "x" },
  });
  history.commit({ message: "newer", files: { "generations/0.json": "newer" } });
  await Promise.all(pending);
  await Promise.all(landed);

  const record = await env.MODULE_MAPS.get("history/generations/0.json");

  expect(await record?.text()).toBe("newer");
});
