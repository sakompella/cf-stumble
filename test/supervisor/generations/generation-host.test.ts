import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { GenerationHostTarget } from "../../../src/supervisor/conversations/host-target.js";
import { readGenerations } from "../generation-reads.js";
import { readyArtifact, storeModuleMap } from "../helpers.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  await reset();
});

test("a repeated submission through the generation host keeps one label, and overlapping preparations run one check", async () => {
  const control = env.SUPERVISOR.getByName("generation-host-duplicates");
  await storeModuleMap(readyArtifact(commit));

  const { submissions, preparations, before, after } = await runInDurableObject(
    control,
    async (supervisor) => {
      const host = new GenerationHostTarget(supervisor, () => true);

      const submitted = [await host.submitGeneration(commit), await host.submitGeneration(commit)];
      const label = submitted[0]?.generation.label ?? -1;
      const statusBefore = await host.generationStatus();

      const prepared = await Promise.all([
        host.prepareGeneration(label),
        host.prepareGeneration(label),
      ]);

      return {
        submissions: submitted,
        preparations: prepared,
        before: statusBefore,
        after: await host.generationStatus(),
      };
    },
  );

  expect(submissions[1]).toStrictEqual(submissions[0]);
  expect(await readGenerations(control)).toHaveLength(1);
  expect(preparations[0]).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(preparations[1]).toStrictEqual(preparations[0]);
  expect(after.epoch, "one check records one preparation").toBe(before.epoch + 1);
});
