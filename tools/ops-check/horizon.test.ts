import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endsNow } from "./horizon.mts";
import { MINUTE_MS } from "./model.mts";

describe("endsNow", () => {
  const now = Date.parse("2026-10-02T16:00:00Z");

  it("is true for a window ending at the check, and for one a few seconds short of it", () => {
    assert.equal(endsNow({ fromMs: now - 60 * MINUTE_MS, toMs: now }, now), true);
    assert.equal(endsNow({ fromMs: now - 60 * MINUTE_MS, toMs: now - 30_000 }, now), true);
  });

  it("is false for an explicit --to a few minutes ago", () => {
    assert.equal(endsNow({ fromMs: now - 60 * MINUTE_MS, toMs: now - 5 * MINUTE_MS }, now), false);
  });
});
