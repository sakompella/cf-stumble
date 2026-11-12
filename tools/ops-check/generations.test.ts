import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "../json.mts";
import { generationLine, latestSwitch, parseEvent, parseEventKeys } from "./generations.mts";

const listing = (keys: readonly string[]): JsonValue => ({
  result: keys.map((key) => ({ key, last_modified: "2026-11-11T10:00:00.000Z" })),
  result_info: { cursor: "next", is_truncated: true },
});

const OLD_EVENT = {
  kind: "activated",
  label: 27,
  epoch: 100,
  time: "2026-11-11T10:00:00.000Z",
  outcome: null,
  errorCode: null,
};

const event = (kind: string, actor: string) => parseEvent({ ...OLD_EVENT, kind, actor });

describe("parseEventKeys and latestSwitch", () => {
  it("picks the activation or rollback with the highest epoch, not the last key in R2 order", () => {
    const { keys, cursor } = parseEventKeys(
      listing([
        "history/events/100-rolled-back.json",
        "history/events/101-proven.json",
        "history/events/99-activated.json",
        "history/generations/27.json",
      ]),
    );

    assert.equal(cursor, "next");
    assert.equal(keys.length, 3);
    assert.equal(latestSwitch(keys)?.key, "history/events/100-rolled-back.json");
  });
});

describe("generationLine", () => {
  it("reads an event written before actors as an unknown actor", () => {
    assert.equal(parseEvent(OLD_EVENT).actor, "unknown");
  });

  it("names the last recorded activation and counts the window's events by actor", () => {
    const line = generationLine({
      status: "ok",
      data: {
        active: event("rolled-back", "probation"),
        inWindow: [
          event("activated", "conversation"),
          parseEvent(OLD_EVENT),
          event("proven", "probation"),
          event("probation-failed", "probation"),
          event("rolled-back", "probation"),
        ],
      },
    });

    assert.deepEqual(line, [
      "i generations: last recorded activation: generation 27 (rolled-back by probation); in the window activated owner 0, conversation 1, unknown 1; proven 1; rolled back 1 (probation 1)",
    ]);
  });

  it("says unknown when R2 cannot be read", () => {
    assert.deepEqual(generationLine({ status: "unavailable", reason: "HTTP 403 from /r2" }), [
      "i generations unknown: HTTP 403 from /r2",
    ]);
  });
});
