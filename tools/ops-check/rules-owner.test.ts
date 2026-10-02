/** Rule c: which logged work explains container CPU. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketsOf, eventRow, input, logs, metrics } from "./fixtures.mts";
import { BUCKET_MS, MINUTE_MS } from "./model.mts";
import { firing, START, WINDOW } from "./rule-helpers.mts";
import type { JsonRecord } from "../browser-harness/json.mts";

describe("rule c: what owns container time", () => {
  const hot = (buckets: number) =>
    metrics(
      bucketsOf({ fromMs: START, toMs: START + buckets * BUCKET_MS }, () => 99),
      [[START, 0]],
    );

  const check = (events: readonly JsonRecord[]) =>
    firing(input(WINDOW, { logs: logs(events), metrics: hot(7) }));

  const idleRoute = eventRow(START - 60 * MINUTE_MS, "route.settled", {
    requestId: "r",
    route: "/api/projects",
    durationMs: 1,
  });

  it("fires on 35 minutes of CPU when nothing owns it", () => {
    assert.deepEqual(check([idleRoute]), ["unowned-cpu"]);
  });

  it("is owned by a 35-minute exec logged once, at its end", () => {
    const exec = eventRow(START + 35 * MINUTE_MS, "workspace.exec", { durationMs: 35 * MINUTE_MS });

    assert.deepEqual(check([idleRoute, exec]), []);
  });

  it("is owned by a harness build step", () => {
    const build = eventRow(START + 35 * MINUTE_MS, "harness-build.step", {
      durationMs: 35 * MINUTE_MS,
    });

    assert.deepEqual(check([idleRoute, build]), []);
  });

  it("is owned for the startup grace after a launch, and no longer", () => {
    const started = eventRow(START, "workspace.container.started", {});

    assert.deepEqual(check([idleRoute, started]), []);
    assert.deepEqual(
      firing(input(WINDOW, { logs: logs([idleRoute, started]), metrics: hot(10) })),
      ["unowned-cpu"],
    );
  });

  it("is not owned by other lifecycle events", () => {
    const stopped = eventRow(START + 5 * MINUTE_MS, "workspace.container.stopped", {});

    assert.deepEqual(check([idleRoute, stopped]), ["unowned-cpu"]);
  });
});
