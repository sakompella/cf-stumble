import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { GenerationOperations } from "../../../src/generation-requests.js";
import { GenerationHostTarget } from "../../../src/supervisor/conversations/host-target.js";
import { controlRequest, ownerApiResponse, ownerApiSupervisor } from "../../routes/helpers.js";

const notCalled = () => Promise.reject(new Error("not this operation"));

function recording() {
  const reached: (string | number | object)[] = [];

  const operations: GenerationOperations = {
    getActiveGeneration: () => ({ generation: undefined, epoch: 0 }),
    submitGeneration: (harnessCommit) => {
      reached.push(harnessCommit);

      return notCalled();
    },
    prepareGeneration: (label) => {
      reached.push(label);

      return notCalled();
    },
    controlGeneration: (command) => {
      reached.push(command);

      return { ok: false, problem: { code: "stale-epoch" } };
    },
  };

  return { reached, operations };
}

const label = gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER });

const notLabel = gs.oneOf(
  gs.integers({ minValue: Number.MIN_SAFE_INTEGER, maxValue: -1 }),
  gs.sampledFrom([2 ** 53, 1.5, "7", null, true, [], {}] as const),
);

const field = gs.oneOf(label, notLabel);

const commit = gs.oneOf(
  gs.fromRegex("(?:[0-9a-f]{40}|[0-9a-f]{64})", { fullmatch: true }),
  gs.text({ maxSize: 70 }),
);

const kind = gs.sampledFrom(["activate", "rollback"] as const);

async function settled<T>(call: () => Promise<T>): Promise<void> {
  await call().then(
    () => {},
    () => {},
  );
}

test("the generation host admits exactly the control commands the HTTP routes admit, unchanged", async () => {
  await hegel.testAsync(async (tc) => {
    const body = { label: tc.draw(field), observedEpoch: tc.draw(field) };
    const commandKind = tc.draw(kind);
    const viaHttp = recording();
    const viaRpc = recording();

    await ownerApiResponse(
      controlRequest(`/api/generations/${commandKind}`, JSON.stringify(body)),
      ownerApiSupervisor({
        controlGeneration: (command) =>
          Promise.resolve(viaHttp.operations.controlGeneration(command)),
      }),
    );

    await settled(() =>
      new GenerationHostTarget(viaRpc.operations).controlGeneration({ kind: commandKind, ...body }),
    );

    expect(viaRpc.reached).toStrictEqual(viaHttp.reached);
  });
});

test("the generation host admits exactly the commits the HTTP submission admits, unchanged", async () => {
  await hegel.testAsync(async (tc) => {
    const harnessCommit = tc.draw(commit);
    const viaHttp = recording();
    const viaRpc = recording();

    await ownerApiResponse(
      controlRequest("/api/generations/submit", JSON.stringify({ harnessCommit })),
      ownerApiSupervisor({
        submitGeneration: (submitted) =>
          Promise.resolve(viaHttp.operations.submitGeneration(submitted)),
      }),
    );

    await settled(() =>
      new GenerationHostTarget(viaRpc.operations).submitGeneration(harnessCommit),
    );

    expect(viaRpc.reached).toStrictEqual(viaHttp.reached);
  });
});

test("the generation host refuses a malformed request without reaching the Supervisor", async () => {
  await hegel.testAsync(async (tc) => {
    const { reached, operations } = recording();
    const host = new GenerationHostTarget(operations);
    const extra = tc.draw(gs.text({ minSize: 1, maxSize: 8 }));
    const otherKind = tc.draw(gs.text({ maxSize: 9 }));

    tc.assume(!["kind", "label", "observedEpoch"].includes(extra));
    tc.assume(otherKind !== "activate" && otherKind !== "rollback");

    const malformed: (() => Promise<object>)[] = [
      () => host.prepareGeneration(tc.draw(notLabel)),
      () => host.controlGeneration({ kind: otherKind, label: 0, observedEpoch: 0 }),
      () => host.controlGeneration({ kind: "activate", label: 0, observedEpoch: 0, [extra]: 1 }),
      () =>
        host.controlGeneration({ kind: "rollback", label: tc.draw(notLabel), observedEpoch: 0 }),
    ];

    for (const call of malformed) await settled(call);

    expect(reached).toStrictEqual([]);
  });
});
