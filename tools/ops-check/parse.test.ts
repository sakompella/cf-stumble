import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuration, parseOptions } from "./args.mts";
import {
  canceledInvocationRow,
  eventRow,
  graphql,
  PROVISIONED_MEMORY_BYTES,
  telemetry,
} from "./fixtures.mts";
import { parseApplications, parseMetrics, parseTelemetry } from "./parse.mts";

describe("telemetry parsing", () => {
  it("keeps fields the rules read and drops rows without an event name or timestamp", () => {
    const parsed = parseTelemetry(
      telemetry([
        eventRow(1000, "route.settled", {
          requestId: "r",
          route: "/api/x",
          durationMs: 5,
          level: "warn",
        }),
        { source: { level: "info", message: "no event field" }, timestamp: 1 },
        { source: { event: "no.timestamp" } },
      ]),
      telemetry([canceledInvocationRow(2000, "i", "/api/y", 90_000)]),
    );

    assert.equal(parsed.status, "ok");
    assert.deepEqual(
      parsed.status === "ok" ? parsed.data.events.map((e) => [e.name, e.level, e.spanMs]) : [],
      [["route.settled", "warn", 5]],
    );
    assert.deepEqual(
      parsed.status === "ok" ? parsed.data.invocations.map((i) => [i.route, i.wallTimeMs]) : [],
      [["/api/y", 90_000]],
    );
  });

  it("is unavailable, not empty, for a response of the wrong shape", () => {
    assert.equal(parseTelemetry({ success: false }, telemetry([])).status, "unavailable");
  });
});

function row(time: string, sum: Record<string, number>) {
  return { dimensions: { datetimeFiveMinutes: time }, sum };
}

describe("metrics parsing", () => {
  it("sums instances in one bucket and converts byte-seconds to running minutes", () => {
    const parsed = parseMetrics(
      graphql("containersMetricsAdaptiveGroups", [
        row("2026-10-01T00:00:00Z", { cpuTimeSec: 10 }),
        row("2026-10-01T00:00:00Z", { cpuTimeSec: 5 }),
      ]),
      graphql("containersUsageAdaptiveGroups", [
        row("2026-10-01T00:00:00Z", { allocatedMemory: 3 * 60 * PROVISIONED_MEMORY_BYTES }),
      ]),
      PROVISIONED_MEMORY_BYTES,
    );

    assert.deepEqual(
      parsed.status === "ok"
        ? [parsed.data.cpu[0]?.cpuTimeSec, parsed.data.usage[0]?.runningMinutes]
        : [],
      [15, 3],
    );
  });

  it("is unavailable when GraphQL answers with errors", () => {
    const failed = { errors: [{ message: "denied" }], data: null };

    assert.equal(
      parseMetrics(failed, graphql("containersUsageAdaptiveGroups", []), 1).status,
      "unavailable",
    );
  });
});

describe("containers API parsing", () => {
  it("reads id, name and memory", () => {
    const parsed = parseApplications({
      result: [{ id: "a", name: "w-host", configuration: { memory_mib: 8192 } }, { id: "b" }],
    });

    assert.deepEqual(parsed, [{ id: "a", name: "w-host", memoryBytes: PROVISIONED_MEMORY_BYTES }]);
  });
});

describe("command line", () => {
  it("parses durations", () => {
    assert.equal(parseDuration("90m"), 90 * 60_000);
    assert.equal(parseDuration("2h"), 2 * 3_600_000);
    assert.equal(parseDuration("2x"), null);
  });

  it("builds a window ending now, or answers why the arguments are wrong", () => {
    const parsed = parseOptions(["--worker", "w", "--since", "2h", "--json"], 10 * 3_600_000);

    assert.deepEqual(
      parsed.kind === "options"
        ? [parsed.options.window, parsed.options.idleLimitMs, parsed.options.json]
        : [],
      [{ fromMs: 8 * 3_600_000, toMs: 10 * 3_600_000 }, 20 * 60_000, true],
    );
    assert.equal(parseOptions(["--since", "2h"], 0).kind, "invalid");
    assert.equal(parseOptions(["--worker", "w"], 0).kind, "invalid");
  });
});
