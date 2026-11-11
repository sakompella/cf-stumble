import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import {
  activation,
  preparation,
  settlement,
  submission,
  type Step,
} from "../../../src/supervisor/generation-machine.js";
import type { RunOutcome } from "../../../src/supervisor/conversations/index.js";
import type { PreparationOutcome } from "../../../src/supervisor/generations.js";
import {
  Serving,
  type LabeledGeneration,
  type Selection,
} from "../../../src/supervisor/generation-state.js";
import { label, testHarnessCommit } from "./fixtures.js";
import {
  activate,
  fresh,
  prepare,
  settle,
  submit,
  type Model,
  type Result,
} from "./generation-model.js";

type World = {
  selection: Selection;
  store: Map<number, LabeledGeneration>;
  model: Model;
  host: string;
};

const LABELS = 4;

const HOSTS = ["host-1", "host-2"];

const submitted = gs.integers({ minValue: 0, maxValue: LABELS - 1 });

const outcome = gs.sampledFrom([
  "completed",
  "completed",
  "completed",
  "failed",
  "failed",
  "interrupted",
  "cancelled",
  "unanswered",
  "replaced",
] as const);

const errorCode = gs.optional(gs.sampledFrom(["faulted", "model_error"]));

const epochOffset = gs.sampledFrom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1]);

function check<Reply>(world: World, step: Step<Reply>, expected: Result<Reply>): void {
  if (step.generation !== undefined) world.store.set(step.generation.label, step.generation);

  world.selection = step.selection ?? world.selection;

  expect(step.reply).toEqual(expected.reply);
  expect(step.commands).toEqual(expected.commands);
}

function servingView(serving: Serving): { active: number | null; proven: number | null } {
  return Serving.match(serving, {
    Unproven: ({ active }) => ({ active, proven: null }),
    Proven: ({ active }) => ({ active, proven: active }),
    Probation: ({ active, fallback }) => ({ active, proven: fallback }),
  });
}

function prepared(tc: hegel.TestCase, world: World): PreparationOutcome {
  const other = HOSTS.find((host) => host !== world.host) ?? world.host;

  return tc.draw(
    gs.sampledFrom<PreparationOutcome>([
      { status: "ready", compatibility: world.host },
      { status: "ready", compatibility: world.host },
      { status: "ready", compatibility: other },
      { status: "failed" },
    ]),
  );
}

function agrees(world: World): void {
  const { epoch, active, proven } = world.model;

  expect({ epoch: world.selection.epoch, ...servingView(world.selection.serving) }).toEqual({
    epoch,
    active,
    proven,
  });

  expect(world.store.size).toBe(world.model.generations.size);

  for (const [value, entry] of world.store) {
    const expected = world.model.generations.get(value);

    expect({
      kind: entry.state._tag.toLowerCase(),
      commit: entry.harnessCommit,
      compat: "compatibility" in entry.state ? entry.state.compatibility : null,
    }).toEqual(expected);
  }
}

function submitStep(world: World, target: number, digit: number): void {
  const commit = testHarnessCommit(String(digit).repeat(40));

  check(
    world,
    submission(
      world.selection,
      world.store.get(target),
      {
        label: label(target),
        harnessCommit: commit,
      },
      "owner",
    ),
    submit(world.model, target, commit),
  );
}

function prepareStep(world: World, target: number, result: PreparationOutcome): void {
  const current = world.store.get(target);

  if (current === undefined) throw new Error(`no generation ${target}`);

  check(
    world,
    preparation(world.selection, current, result, "owner"),
    prepare(world.model, target, result),
  );
}

function controlStep(
  world: World,
  kind: "activate" | "rollback",
  target: number,
  observedEpoch: number,
): void {
  const command = { kind, label: label(target), observedEpoch };

  check(
    world,
    activation(world.selection, world.store.get(target), command, world.host, "owner"),
    activate(world.model, { kind, label: target, observedEpoch }, world.host),
  );
}

function settleStep(world: World, ended: RunOutcome, code: string | null): void {
  const { serving } = world.selection;

  const fallback = Serving.guards.Probation(serving)
    ? world.store.get(serving.fallback)
    : undefined;

  check(
    world,
    settlement(world.selection, fallback, { outcome: ended, errorCode: code }, world.host),
    settle(world.model, ended, code, world.host),
  );
}

function usableLabels(world: World): number[] {
  return [...world.store.values()].flatMap((entry) =>
    entry.state._tag === "Ready" || entry.state._tag === "Served" ? [entry.label] : [],
  );
}

const machine: hegel.stateful.StateMachine<World> = {
  rules: {
    submit: (tc, world) => {
      submitStep(world, tc.draw(submitted), tc.draw(gs.integers({ minValue: 0, maxValue: 9 })));
    },
    prepare: (tc, world) => {
      tc.assume(world.store.size > 0);

      prepareStep(world, tc.draw(gs.sampledFrom([...world.store.keys()])), prepared(tc, world));
    },
    control: (tc, world) => {
      const usable = usableLabels(world);
      const aimed = usable.length > 0 && tc.draw(gs.booleans());
      const target = tc.draw(gs.sampledFrom(aimed ? usable : [...world.store.keys(), LABELS]));
      const kind = tc.draw(gs.sampledFrom(["activate", "activate", "rollback"] as const));

      controlStep(world, kind, target, world.selection.epoch + tc.draw(epochOffset));
    },
    serveNew: (tc, world) => {
      const target = tc.draw(submitted);

      tc.assume(!world.store.has(target));

      submitStep(world, target, tc.draw(gs.integers({ minValue: 0, maxValue: 9 })));
      prepareStep(world, target, { status: "ready", compatibility: world.host });
      controlStep(world, "activate", target, world.selection.epoch);
    },
    settled: (tc, world) => {
      settleStep(world, tc.draw(outcome), tc.draw(errorCode));
    },
    failProbation: (tc, world) => {
      tc.assume(Serving.guards.Probation(world.selection.serving));

      world.host = tc.draw(gs.sampledFrom(HOSTS));
      settleStep(
        world,
        tc.draw(gs.sampledFrom(["failed", "interrupted"] as const)),
        tc.draw(errorCode),
      );
    },
    upgradeHost: (tc, world) => {
      world.host = tc.draw(gs.sampledFrom(HOSTS));
    },
  },
  invariants: {
    agrees: {
      alwaysCheck: true,
      check: (_tc, world) => {
        agrees(world);
      },
    },
  },
};

test("the generation machine agrees with a model of submission, preparation, activation and probation over any sequence of events", () => {
  hegel.test((tc) => {
    const world: World = {
      selection: { epoch: 0, serving: Serving.cases.Unproven.make({ active: null }) },
      store: new Map(),
      model: fresh(),
      host: HOSTS[0] ?? "",
    };

    hegel.stateful.run(tc, machine, world, { stepCount: 40 });
  });
});
