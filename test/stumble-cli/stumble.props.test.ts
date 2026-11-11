import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { GenerationControl } from "../../src/generation-requests.js";
import { runStumble } from "../../src/stumble-cli/index.js";
import type { Generation } from "../../src/supervisor/generations.js";
import { label as generationLabel, testHarnessCommit } from "../supervisor/generations/fixtures.js";

type Selection = { label: number | undefined; epoch: number };

type Stage = "ready" | "mount-failed";

function generation(label: number): Generation {
  return {
    label: generationLabel(label),
    harnessCommit: testHarnessCommit("a".repeat(40)),
    status: "ready",
  };
}

function generationControl(selection: Selection, stage: Stage = "ready") {
  const reached: object[] = [];

  const generations: GenerationControl = {
    generationStatus: () =>
      Promise.resolve({
        generation: selection.label === undefined ? null : generation(selection.label),
        epoch: selection.epoch,
      }),
    submitGeneration: (harnessCommit) => {
      reached.push({ submitted: harnessCommit });

      return Promise.resolve({
        kind: "candidate-submitted" as const,
        generation: generation(7),
        epoch: 1,
      });
    },
    prepareGeneration: (label) => {
      reached.push({ prepared: label });

      return Promise.resolve({
        ok: true as const,
        report: { stage, reason: "", generation: generation(label), effect: "recorded" as const },
      });
    },
    controlGeneration: (command) => {
      reached.push(command);

      if (command.observedEpoch !== selection.epoch) {
        return Promise.resolve({ ok: false as const, problem: { code: "stale-epoch" as const } });
      }

      selection.label = command.label;
      selection.epoch += 1;

      return Promise.resolve({
        ok: true as const,
        outcome: {
          kind: "activated" as const,
          generation: generation(command.label),
          epoch: selection.epoch,
          effect: "activated" as const,
        },
      });
    },
  };

  return { reached, ports: { generations } };
}

const word = gs.fromRegex("[a-z-]{1,10}", { fullmatch: true });

test("an unknown command fails with the help of the command it was given to", async () => {
  await hegel.testAsync(async (tc) => {
    const path = tc.draw(gs.sampledFrom([[], ["gen"]] as const));
    const unknown = tc.draw(word);
    tc.assume(!["gen", "help", "status", "prepare", "activate", "rollback"].includes(unknown));
    const { reached, ports } = generationControl({ label: undefined, epoch: 0 });

    const help = await runStumble(path, ports);
    const failed = await runStumble([...path, unknown], ports);

    expect(help.exitCode).toBe(0);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toBe("");
    expect(failed.stderr.endsWith(help.stdout)).toBe(true);
    expect(reached).toStrictEqual([]);
  });
});

test("the help of stumble and of stumble gen names each of their commands", async () => {
  const { ports } = generationControl({ label: undefined, epoch: 0 });
  const root = await runStumble([], ports);
  const gen = await runStumble(["gen"], ports);

  expect(root.stdout).toMatch(/^ {2}gen <command> /mu);

  for (const command of ["status", "prepare", "activate", "rollback"]) {
    expect(gen.stdout).toMatch(new RegExp(`^ {2}${command}\\b`, "mu"));
  }
});

test("a ready preparation prints an activate command that activates the prepared generation", async () => {
  await hegel.testAsync(async (tc) => {
    const commit = tc.draw(gs.fromRegex("[0-9a-f]{40}", { fullmatch: true }));

    const selection = {
      label: undefined,
      epoch: tc.draw(gs.integers({ minValue: 0, maxValue: 99 })),
    };

    const { reached, ports } = generationControl(selection);

    const prepared = await runStumble(["gen", "prepare", commit], ports);
    const printed = prepared.stdout.match(/stumble (gen activate .*)$/mu)?.[1] ?? "";
    const activated = await runStumble(printed.split(" "), ports);

    expect(prepared.exitCode).toBe(0);
    expect(activated.exitCode).toBe(0);
    expect(selection.label).toBe(7);
    expect(reached.slice(0, 2)).toStrictEqual([{ submitted: commit }, { prepared: 7 }]);
  });
});

test("a preparation that fails its startup check exits non-zero", async () => {
  const { ports } = generationControl({ label: undefined, epoch: 0 }, "mount-failed");

  expect((await runStumble(["gen", "prepare", "b".repeat(40)], ports)).exitCode).toBe(1);
});

function failing(method: "generationStatus" | "prepareGeneration", message: string) {
  const { ports } = generationControl({ label: undefined, epoch: 0 });

  return {
    generations: { ...ports.generations, [method]: () => Promise.reject(new Error(message)) },
  };
}

test("a request that fails says why, without a credential in its message", async () => {
  const token = `ghp_${"a".repeat(36)}`;

  const ran = await runStumble(
    ["gen", "status"],
    failing("generationStatus", `the Supervisor is unavailable (${token})`),
  );

  expect(ran.exitCode).toBe(1);
  expect(ran.stderr).toContain(
    "stumble gen status: the request failed: the Supervisor is unavailable",
  );
  expect(ran.stderr).not.toContain(token);
});

test("a preparation whose startup check request fails still names the submitted generation", async () => {
  const ran = await runStumble(
    ["gen", "prepare", "c".repeat(40)],
    failing("prepareGeneration", "the Supervisor is unavailable"),
  );

  expect(ran.exitCode).toBe(1);
  expect(ran.stderr).toBe(
    `submitted generation 7 for ${"c".repeat(40)}\ngeneration 7 was not prepared: the Supervisor is unavailable\n`,
  );
});

test("a repeated activation after its epoch moved on reports the generation as already active", async () => {
  await hegel.testAsync(async (tc) => {
    const epoch = tc.draw(gs.integers({ minValue: 0, maxValue: 99 }));
    const label = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));

    const selection = {
      label: tc.draw(gs.integers({ minValue: 0, maxValue: 9 })),
      epoch: epoch + 1,
    };

    const { ports } = generationControl(selection);

    const again = await runStumble(
      ["gen", "activate", String(label), "--epoch", String(epoch)],
      ports,
    );

    expect(again.exitCode === 0).toBe(selection.label === label);
  });
});

test("a control command reaches the Supervisor only with a decimal label and epoch", async () => {
  await hegel.testAsync(async (tc) => {
    const args = tc.draw(
      gs.arrays(
        gs.oneOf(word, gs.fromRegex("[0-9]{1,3}", { fullmatch: true }), gs.just("--epoch")),
        { maxSize: 4 },
      ),
    );

    const kind = tc.draw(gs.sampledFrom(["activate", "rollback"] as const));
    const { reached, ports } = generationControl({ label: undefined, epoch: 0 });

    const ran = await runStumble(["gen", kind, ...args], ports);

    const wellFormed =
      args.length === 3 &&
      /^\d+$/u.test(args[0] ?? "") &&
      args[1] === "--epoch" &&
      /^\d+$/u.test(args[2] ?? "");

    expect(reached).toStrictEqual(
      wellFormed ? [{ kind, label: Number(args[0]), observedEpoch: Number(args[2]) }] : [],
    );
    expect(ran.exitCode === 2).toBe(!wellFormed);
  });
});
