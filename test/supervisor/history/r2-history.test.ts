import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { changeCommit, type HistoryCommit } from "../../../src/supervisor/history/commits.js";
import { r2History } from "../../../src/supervisor/history/r2-history.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { reset, runInDurableObject } from "cloudflare:test";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";

afterEach(async () => {
  await reset();
});

function commitFor(name: string, hash: string): Promise<HistoryCommit> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const commits: HistoryCommit[] = [];

    new Generations(state.storage, FACET_COMPATIBILITY, (change) => {
      commits.push(changeCommit(change, 1_700_000_000_000));
    }).submit(testHarnessCommit(hash), "owner");

    return commits[0] ?? { message: "none", files: {} };
  });
}

test("an append stores each file as a JSON object under history/", async () => {
  const commit = await commitFor("r2-history-put", "a".repeat(40));

  await r2History(env.MODULE_MAPS)(commit);

  const listed = await env.MODULE_MAPS.list({ prefix: "history/" });
  expect(listed.objects.map((object) => object.key).toSorted()).toEqual([
    "history/events/1-submitted.json",
    "history/generations/0.json",
  ]);

  const event = await env.MODULE_MAPS.get("history/events/1-submitted.json");
  expect(JSON.parse((await event?.text()) ?? "")).toMatchObject({ kind: "submitted", epoch: 1 });
});

test("a later append for the same generation overwrites its record", async () => {
  const append = r2History(env.MODULE_MAPS);
  const first = await commitFor("r2-history-overwrite", "b".repeat(40));

  await append(first);
  await append({ message: "again", files: { "generations/0.json": '{"status":"ready"}' } });

  const record = await env.MODULE_MAPS.get("history/generations/0.json");
  expect(await record?.text()).toBe('{"status":"ready"}');
});
