import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReport, runChecks } from "./check.mts";
import {
  healthyDay,
  incident0926,
  incident0927,
  logs,
  missingMetricsDay,
  stagingWorkerRows,
} from "./fixtures.mts";
import type { CheckInput, RuleId } from "./model.mts";

function rules(checked: CheckInput): readonly RuleId[] {
  return [...new Set(runChecks(checked).map((finding) => finding.rule))].toSorted();
}

describe("incident fixtures", () => {
  it("09-26: finds the slow, canceled poller and the live container closes, not unowned CPU", () => {
    assert.deepEqual(rules(incident0926()), ["poller", "running-close", "slow-requests"]);
  });

  it("09-27: finds 19 hours of CPU no log owns, and the stop with no known reason", () => {
    assert.deepEqual(rules(incident0927()), ["ran-past-idle", "unexplained-stop", "unowned-cpu"]);
  });

  it("a healthy day passes with one line", () => {
    const checked = healthyDay();

    assert.deepEqual(runChecks(checked), []);
    assert.deepEqual(formatReport(checked, []), [
      "✓ ops-check cf-stumble 2026-09-30T00:00Z..00:00Z",
    ]);
  });

  it("a day with missing metrics is unknown, not clean", () => {
    assert.deepEqual(rules(missingMetricsDay()), ["unknown"]);
  });

  it("never reports clean when a source is unavailable, whatever the other says", () => {
    for (const checked of [incident0926(), incident0927(), healthyDay()]) {
      const noMetrics = {
        ...checked,
        metrics: { status: "unavailable", reason: "no token" } as const,
      };

      const noLogs = { ...checked, logs: { status: "unavailable", reason: "no token" } as const };

      assert.ok(rules(noMetrics).includes("unknown"));
      assert.ok(rules(noLogs).includes("unknown"));
    }
  });

  it("reports logs as unknown when metrics show a busy container and logs are empty", () => {
    const base = healthyDay();
    const checked = { ...base, logs: logs([]) };

    assert.deepEqual(rules(checked), ["unknown"]);
  });
});

describe("another Worker on the same account", () => {
  it("adds no finding to a healthy day", () => {
    const window = healthyDay().window;

    assert.deepEqual(rules(healthyDay(stagingWorkerRows(window))), []);
  });

  it("does not own CPU that is unowned, or hide the 09-27 findings", () => {
    const window = incident0927().window;

    assert.deepEqual(rules(incident0927(stagingWorkerRows(window))), [
      "ran-past-idle",
      "unexplained-stop",
      "unowned-cpu",
    ]);
  });
});

describe("report format", () => {
  it("prints one line per finding with measured value, window and evidence", () => {
    const lines = formatReport(incident0926(), runChecks(incident0926()));

    assert.equal(lines.length, 3);
    assert.match(
      lines.join("\n"),
      /✗ poller 38\/h >= 20\/h on \/api\/github\/connection, 0 touch the workspace, 38 canceled 2026-09-26T18:00Z\.\.21:00Z \[inv:poll-0/u,
    );
  });
});
