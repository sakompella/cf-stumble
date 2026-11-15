import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import type { GenerationStatus } from "../../../src/supervisor/generations.js";
import type { GenerationChange } from "../../../src/supervisor/history/commits.js";
import { GenerationHistory } from "../../../src/supervisor/history/log.js";
import { r2History } from "../../../src/supervisor/history/r2-history.js";
import { tick } from "../../eventually.js";
import { label, testHarnessCommit } from "../generations/fixtures.js";

afterEach(async () => {
  await reset();
});

function change(
  kind: GenerationChange["kind"],
  epoch: number,
  status: GenerationStatus,
): GenerationChange {
  return {
    kind,
    actor: "owner",
    epoch,
    outcome: null,
    errorCode: null,
    record: {
      generation: { label: label(0), harnessCommit: testHarnessCommit("3".repeat(40)), status },
      wasActive: false,
      compatibility: FACET_COMPATIBILITY,
    },
  };
}

function bucketHoldingTheFirstRecordPut() {
  const gate = { release: (): void => {} };
  const putsWhileHeld: string[] = [];
  let holding = false;
  let recordPuts = 0;

  const released = new Promise<void>((resolve) => {
    gate.release = () => {
      holding = false;
      resolve();
    };
  });

  const bucket: R2Bucket = {
    ...env.MODULE_MAPS,
    put(key, value, options) {
      if (key.endsWith("1-submitted.json")) return Promise.reject(new Error("the bucket refused"));

      if (holding) putsWhileHeld.push(key);

      if (key.endsWith("generations/0.json") && (recordPuts += 1) === 1) {
        holding = true;

        return released.then(() => env.MODULE_MAPS.put(key, value, options));
      }

      return env.MODULE_MAPS.put(key, value, options);
    },
  };

  return { bucket, release: gate.release, putsWhileHeld };
}

test("a history write after one whose put failed waits for the older put still in flight, so the older generation record cannot overwrite the newer one (SC-2, 15c92fc6)", async () => {
  const { bucket, release, putsWhileHeld } = bucketHoldingTheFirstRecordPut();
  const pending: Promise<void>[] = [];

  const history = new GenerationHistory(
    r2History(bucket),
    (promise) => {
      pending.push(promise);
    },
    () => 1,
  );

  history.record(change("submitted", 1, "candidate"));
  history.record(change("prepared", 2, "ready"));
  await tick();

  expect(putsWhileHeld, "nothing of the newer write starts before the older one settles").toEqual(
    [],
  );
  release();
  await Promise.all(pending);

  const record = await env.MODULE_MAPS.get("history/generations/0.json");
  expect(JSON.parse((await record?.text()) ?? "")).toMatchObject({ status: "ready" });
});
