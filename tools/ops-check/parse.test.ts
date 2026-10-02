import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuration, parseOptions } from "./args.mts";
import {
  canceledInvocationRow,
  eventRow,
  graphql,
  PROVISIONED_MEMORY_BYTES,
  telemetry,
  WORKER,
} from "./fixtures.mts";
import { parseApplications, parseInstances, parseMetrics, parseTelemetry } from "./parse.mts";

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
      WORKER,
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

  it("drops events and invocations from another Worker on the account", () => {
    const parsed = parseTelemetry(
      telemetry([
        eventRow(1000, "turn.settled", {}, "cf-stumble-staging"),
        eventRow(2000, "turn.settled"),
      ]),
      telemetry([canceledInvocationRow(3000, "i", "/api/y", 1, "canceled", "cf-stumble-staging")]),
      WORKER,
    );

    assert.deepEqual(parsed.status === "ok" ? parsed.data.events.map((e) => e.atMs) : [], [2000]);
    assert.deepEqual(parsed.status === "ok" ? parsed.data.invocations : [], []);
  });

  it("is unavailable, not empty, for a response of the wrong shape", () => {
    assert.equal(parseTelemetry({ success: false }, telemetry([]), WORKER).status, "unavailable");
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
  it("reads running instances from status.updated_at, not started_at", () => {
    const parsed = parseInstances({
      result: {
        instances: [
          {
            id: "i1",
            started_at: "2026-10-02T13:17:54Z",
            status: { state: "running", updated_at: "2026-10-02T15:08:22Z" },
          },
          { id: "i2", status: { state: "stopped" } },
        ],
      },
    });

    assert.deepEqual(parsed, [{ id: "i1", runningSinceMs: Date.parse("2026-10-02T15:08:22Z") }]);
  });

  it("is unavailable when a running instance has no usable running-since time", () => {
    const noTime = { result: { instances: [{ id: "i1", status: { state: "running" } }] } };

    assert.equal(parseInstances(noTime), null);
    assert.equal(parseInstances({ result: {} }), null);
  });

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
    assert.equal(
      parseOptions(
        ["--worker", "w", "--since", "1h", "--to", "2026-10-03T00:00:00Z"],
        Date.parse("2026-10-02T00:00:00Z"),
      ).kind,
      "invalid",
    );
    assert.equal(parseOptions(["--worker", "w"], 0).kind, "invalid");
    assert.equal(parseOptions(["--worker", "w", "--since", "2h", "--bogus"], 0).kind, "invalid");
    assert.equal(parseOptions(["--worker"], 0).kind, "invalid");
  });
});
