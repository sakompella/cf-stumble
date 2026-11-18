import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import {
  activation,
  preparation,
  settlement,
  submission,
  type GenerationCommand,
  type Step,
} from "../../src/supervisor/generation-machine.js";
import {
  Serving,
  type ActivationCommand,
  type LabeledGeneration,
  type Selection,
} from "../../src/supervisor/generation-state.js";
import {
  releaseGeneration,
  RequestInterrupted,
  type ReleaseOwner,
} from "../../tools/release-generation/release.mts";
import { label, testHarnessCommit } from "../supervisor/generations/fixtures.js";

const COMPATIBILITY = "facet-1";

const ACTIVE = "a".repeat(40);

const MAIN = "b".repeat(40);

type Supervisor = {
  selection: Selection;
  store: Map<number, LabeledGeneration>;
  commands: GenerationCommand[];
};

const answerFate = gs.sampledFrom(["answered", "answered", "lost-before", "lost-after"] as const);

const runStillActive = gs.sampledFrom([false, false, true]);

const PAUSE_EVENTS = [
  "nothing",
  "nothing",
  "first-run-fails",
  "first-run-proves",
  "owner-rollback",
  "other-commit-prepared",
] as const;

const duringPause = gs.sampledFrom(PAUSE_EVENTS);

function applied<Reply>(supervisor: Supervisor, step: Step<Reply>): Reply {
  if (step.generation !== undefined) {
    supervisor.store.set(step.generation.label, step.generation);
  }

  supervisor.selection = step.selection ?? supervisor.selection;
  supervisor.commands.push(...step.commands);

  return step.reply;
}

function activeLabel(supervisor: Supervisor): number | null {
  return Serving.match(supervisor.selection.serving, {
    Unproven: ({ active }) => active,
    Proven: ({ active }) => active,
    Probation: ({ active }) => active,
  });
}

function submitReady(supervisor: Supervisor, commit: string): number {
  const harnessCommit = testHarnessCommit(commit);

  const existing = [...supervisor.store.values()].find(
    (generation) => generation.harnessCommit === harnessCommit,
  );

  const { generation } = applied(
    supervisor,
    submission(
      supervisor.selection,
      existing,
      { label: label(supervisor.store.size), harnessCommit },
      "owner",
    ),
  );

  const submitted = supervisor.store.get(generation.label);

  if (submitted === undefined) throw new Error(`no generation ${generation.label}`);

  applied(
    supervisor,
    preparation(
      supervisor.selection,
      submitted,
      { status: "ready", compatibility: COMPATIBILITY },
      "owner",
    ),
  );

  return generation.label;
}

function control(supervisor: Supervisor, command: ActivationCommand) {
  return applied(
    supervisor,
    activation(
      supervisor.selection,
      supervisor.store.get(command.label),
      command,
      COMPATIBILITY,
      "owner",
    ),
  );
}

function settled(supervisor: Supervisor, outcome: "completed" | "failed"): void {
  const { serving } = supervisor.selection;

  const fallback = Serving.guards.Probation(serving)
    ? supervisor.store.get(serving.fallback)
    : undefined;

  applied(
    supervisor,
    settlement(supervisor.selection, fallback, { outcome, errorCode: null }, COMPATIBILITY),
  );
}

function servingActive(): Supervisor {
  const supervisor: Supervisor = {
    selection: { epoch: 0, instance: 0, serving: Serving.cases.Unproven.make({ active: null }) },
    store: new Map(),
    commands: [],
  };

  const first = submitReady(supervisor, ACTIVE);

  control(supervisor, {
    kind: "activate",
    label: label(first),
    observedEpoch: supervisor.selection.epoch,
  });
  settled(supervisor, "completed");
  supervisor.commands.length = 0;

  return supervisor;
}

function interfere(supervisor: Supervisor, event: (typeof PAUSE_EVENTS)[number]): void {
  if (event === "first-run-fails") settled(supervisor, "failed");

  if (event === "first-run-proves") settled(supervisor, "completed");

  if (event === "owner-rollback") {
    control(supervisor, {
      kind: "rollback",
      label: label(0),
      observedEpoch: supervisor.selection.epoch,
    });
  }

  if (event === "other-commit-prepared")
    submitReady(supervisor, String(supervisor.store.size).repeat(40));
}

function owner(tc: hegel.TestCase, supervisor: Supervisor): ReleaseOwner {
  return {
    active: () => {
      const active = activeLabel(supervisor);
      const generation = active === null ? undefined : supervisor.store.get(active);

      return Promise.resolve({
        harnessCommit: generation?.harnessCommit,
        epoch: supervisor.selection.epoch,
      });
    },
    submit: (harnessCommit) =>
      Promise.resolve({ kind: "ready", label: submitReady(supervisor, harnessCommit) }),
    activate: (target, observedEpoch) => {
      const fate = tc.draw(answerFate);

      if (fate === "lost-before") return Promise.reject(new RequestInterrupted("reset"));

      const result = tc.draw(runStillActive)
        ? ({ ok: false, problem: { code: "run-active" } } as const)
        : control(supervisor, { kind: "activate", label: label(target), observedEpoch });

      if (fate === "lost-after") return Promise.reject(new RequestInterrupted("answer lost"));

      return Promise.resolve({
        ok: result.ok,
        code: result.ok ? undefined : result.problem.code,
      });
    },
  };
}

test("a release activates its generation at most once, whichever activation answers are lost and whatever changes the active generation in its pauses (formal model 07)", async () => {
  await hegel.testAsync(async (tc) => {
    const supervisor = servingActive();
    let clock = 0;

    const summary = await releaseGeneration(MAIN, {
      owner: owner(tc, supervisor),
      force: false,
      facetChangedSince: () => Promise.resolve(true),
      wait: (ms) => {
        clock += ms;
        interfere(supervisor, tc.draw(duringPause));

        return Promise.resolve();
      },
      now: () => clock,
      report: () => {},
    }).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));

    const release = [...supervisor.store.values()].find(
      (generation) => generation.harnessCommit === testHarnessCommit(MAIN),
    )?.label;

    const activations = supervisor.commands.filter(
      (command) =>
        command._tag === "Changed" && command.kind === "activated" && command.label === release,
    );

    expect(activations.length, summary).toBeLessThanOrEqual(1);

    if (summary.startsWith("Activated")) {
      expect(activations, summary).toHaveLength(1);
      expect(await owner(tc, supervisor).active()).toMatchObject({ harnessCommit: MAIN });
    }
  });
});
