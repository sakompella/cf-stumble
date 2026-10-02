/** Rule e: events that name a fault, and the stops and closes that are not faults. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChecks } from "./check.mts";
import { eventRow } from "./fixtures.mts";
import { MINUTE_MS } from "./model.mts";
import { firing, START, withLogs } from "./rule-helpers.mts";

describe("rule e: fault events", () => {
  const closed = (running: boolean) =>
    eventRow(START + MINUTE_MS, "workspace.backend.closed", { level: "warn", running });

  const stopped = (level: string) =>
    eventRow(START + MINUTE_MS, "workspace.container.stopped", {
      level,
      reasonCode: "unexpected-exit-code",
      reasonSource: "unknown",
    });

  it("fires on a close with running true, not running false or null", () => {
    assert.deepEqual(firing(withLogs([closed(true)])), ["running-close"]);
    assert.deepEqual(firing(withLogs([closed(false)])), []);
    assert.deepEqual(
      firing(
        withLogs([eventRow(START, "workspace.backend.closed", { level: "warn", running: null })]),
      ),
      [],
    );
  });

  it("fires on an unknown stop reason at warn or error, not at info", () => {
    assert.ok(firing(withLogs([stopped("warn")])).includes("unexplained-stop"));
    assert.ok(firing(withLogs([stopped("error")])).includes("unexplained-stop"));
    assert.deepEqual(firing(withLogs([stopped("info")])), []);
  });
});

describe("rule e: the idle stop's own close", () => {
  it("does not report the close the Host makes to stop an idle container", () => {
    const close = (trigger: string) =>
      eventRow(START + MINUTE_MS, "workspace.backend.closed", {
        level: "info",
        running: true,
        trigger,
      });

    assert.deepEqual(firing(withLogs([close("idle-stop")])), []);
    assert.deepEqual(firing(withLogs([close("transport-closed")])), ["running-close"]);
  });
});

describe("rule e: reason codes of the idle stop", () => {
  const stopped = (fields: Record<string, string | boolean>) =>
    eventRow(START + MINUTE_MS, "workspace.container.stopped", fields);

  it("treats an idle stop (application-intent, info, expected) as a normal stop", () => {
    const idle = stopped({
      reasonCode: "idle-stop",
      reasonSource: "application-intent",
      expected: true,
    });

    assert.deepEqual(firing(withLogs([idle])), []);
  });

  it("reports placement-unavailable as its own class, counted, and not as an unexplained stop", () => {
    const placement = stopped({
      level: "warn",
      reasonCode: "placement-unavailable",
      reasonSource: "unknown",
    });

    const findings = runChecks(withLogs([placement, placement, placement]));

    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ["placement-unavailable"],
    );
    assert.match(findings[0]?.detail ?? "", /^3 > 0 /u);
  });

  it("still reports another unknown stop next to placement-unavailable", () => {
    const other = stopped({ level: "warn", reasonCode: "unknown", reasonSource: "unknown" });

    const placement = stopped({
      level: "warn",
      reasonCode: "placement-unavailable",
      reasonSource: "unknown",
    });

    assert.deepEqual(firing(withLogs([other, placement])), [
      "placement-unavailable",
      "unexplained-stop",
    ]);
  });
});

describe("rule e: stops and closes the Host caused", () => {
  const closed = (running: boolean) =>
    eventRow(START + MINUTE_MS, "workspace.backend.closed", { level: "warn", running });

  it("does not report a stop the Host asked for (reasonSource application-intent)", () => {
    const intended = eventRow(START + MINUTE_MS, "workspace.container.stopped", {
      level: "warn",
      reasonCode: "workspace-reset",
      reasonSource: "application-intent",
    });

    assert.deepEqual(firing(withLogs([intended])), []);
  });

  it("does not report a close within seconds of the Host's own stop or wake request", () => {
    const request = (name: string, afterMs: number) =>
      eventRow(START + MINUTE_MS + afterMs, name, {});

    assert.deepEqual(
      firing(withLogs([closed(true), request("workspace.container.stop-requested", 5000)])),
      [],
    );
    assert.deepEqual(
      firing(withLogs([closed(true), request("workspace.container.wake-requested", -5000)])),
      [],
    );
    assert.deepEqual(
      firing(withLogs([closed(true), request("workspace.container.stop-requested", 60_000)])),
      ["running-close"],
    );
  });

  it("fires on any error-level event inside the window, not outside it", () => {
    assert.deepEqual(
      firing(withLogs([eventRow(START + MINUTE_MS, "turn.settled", { level: "error" })])),
      ["error-events"],
    );
    assert.deepEqual(
      firing(withLogs([eventRow(START - MINUTE_MS, "turn.settled", { level: "error" })])),
      [],
    );
  });
});
