import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
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

const kinds = gs.sampledFrom(["activated", "rolled-back", "proven", "probation-failed"]);

describe("parseEventKeys and latestSwitch", () => {
  it("picks the activation or rollback with the highest epoch, whatever order R2 lists the keys in", () => {
    hegel.test((tc) => {
      const epochs = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 10_000 }), { unique: true, maxSize: 8 }),
      );

      const events = epochs.map((epoch) => ({ epoch, kind: tc.draw(kinds) }));
      const keys = events.map(({ epoch, kind }) => `history/events/${epoch}-${kind}.json`);
      const switches = events.filter(({ kind }) => kind === "activated" || kind === "rolled-back");
      const newest = Math.max(...switches.map(({ epoch }) => epoch));

      const expected = switches.find(({ epoch }) => epoch === newest);

      const picked = latestSwitch(
        parseEventKeys(listing([...keys, "history/generations/27.json"])).keys,
      );

      assert.deepEqual(
        picked === undefined
          ? undefined
          : { key: picked.key, epoch: picked.epoch, kind: picked.kind },
        expected === undefined
          ? undefined
          : {
              key: `history/events/${expected.epoch}-${expected.kind}.json`,
              epoch: expected.epoch,
              kind: expected.kind,
            },
      );
    });
  });

  it("passes R2's cursor on while the listing is truncated", () => {
    assert.equal(parseEventKeys(listing([])).cursor, "next");
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
