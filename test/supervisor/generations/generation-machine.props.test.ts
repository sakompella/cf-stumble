import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { activation, preparation, settlement } from "../../../src/supervisor/generation-machine.js";
import { rowFromSelection, selectionFromRow } from "../../../src/supervisor/generation-rows.js";
import {
  GenerationState,
  Serving,
  type LabeledGeneration,
  type Selection,
} from "../../../src/supervisor/generation-state.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { label } from "./fixtures.js";

const COMPATIBILITY = "pi-durable@1.4.0/host-2";

const LABELS = [label(0), label(1), label(2)];

const event = gs.sampledFrom([
  "activate",
  "rollback",
  "completed",
  "failed",
  "unanswered",
  "check-ready",
  "check-failed",
] as const);

function stored(store: ReadonlyMap<number, LabeledGeneration>, value: number) {
  const found = store.get(value);

  if (found === undefined) throw new Error(`no generation ${value}`);

  return found;
}

test("every reachable selection survives its columns, and serves and falls back only to served generations", () => {
  hegel.test((tc) => {
    const store = new Map<number, LabeledGeneration>(
      LABELS.map((value) => [
        value,
        {
          label: value,
          harnessCommit: testHarnessCommit(String(value).repeat(40)),
          state: GenerationState.cases.Ready.make({ compatibility: COMPATIBILITY }),
        },
      ]),
    );

    let selection: Selection = { epoch: 0, serving: Serving.cases.Unproven.make({ active: null }) };

    for (let step = 0; step < 4; step += 1) {
      const kind = tc.draw(event);
      const target = tc.draw(gs.sampledFrom(LABELS));
      const command = { label: target, observedEpoch: selection.epoch };

      const next =
        kind === "activate" || kind === "rollback"
          ? activation(selection, store.get(target), { ...command, kind }, COMPATIBILITY)
          : kind === "check-ready" || kind === "check-failed"
            ? preparation(
                selection,
                stored(store, target),
                kind === "check-ready"
                  ? { status: "ready", compatibility: COMPATIBILITY }
                  : { status: "failed" },
              )
            : settlement(
                selection,
                Serving.guards.Probation(selection.serving)
                  ? store.get(selection.serving.fallback)
                  : undefined,
                { outcome: kind, errorCode: null },
                COMPATIBILITY,
              );

      if (next.generation !== undefined) store.set(next.generation.label, next.generation);

      selection = next.selection ?? selection;

      expect(selectionFromRow(rowFromSelection(selection))).toEqual(selection);

      const { serving } = selection;
      const fallbacks = Serving.guards.Probation(serving) ? [serving.fallback] : [];

      for (const served of [serving.active, ...fallbacks]) {
        if (served !== null) expect(store.get(served)?.state._tag).toBe("Served");
      }
    }
  });
});
