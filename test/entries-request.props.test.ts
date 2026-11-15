import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { encodeEntriesRequest, parseEntriesRequest } from "../src/entries-request.js";

const entryId = gs
  .optional(gs.integers({ minValue: 0, maxValue: 999_999_999_999_999 }))
  .map((value) => value ?? undefined);

const request = gs.record({
  minEntryId: entryId,
  maxEntryId: entryId,
  order: gs.sampledFrom(["ascending", "descending"] as const),
  limit: gs.integers({ minValue: 1, maxValue: 100 }),
});

test("the route parses every entries request the page encodes back to the same request", () => {
  hegel.test((tc) => {
    const drawn = tc.draw(request);

    expect(parseEntriesRequest(encodeEntriesRequest(drawn))).toStrictEqual(drawn);
  });
});

const notACount = gs.oneOf(
  gs.text({ maxSize: 6 }).filter((text) => !/^\d+$/u.test(text)),
  gs.sampledFrom(["-1", "1.5", "1e2", "0x10", "+5", " 5", "5 "]),
  gs.integers({ minValue: 1_000_000_000_000_000, maxValue: 9_000_000_000_000_000 }).map(String),
);

const outOfRangeLimit = gs.oneOf(
  gs.just("0"),
  gs.integers({ minValue: 101, maxValue: 999_999_999_999_999 }).map(String),
);

const notAnOrder = gs
  .text({ maxSize: 12 })
  .filter((text) => text !== "ascending" && text !== "descending");

const invalidValue = {
  min: notACount,
  max: notACount,
  limit: gs.oneOf(notACount, outOfRangeLimit),
  order: notAnOrder,
};

test("a request with a bound or limit that is not a count, a limit outside 1 to 100, or an unknown order is refused, not given a default", () => {
  hegel.test((tc) => {
    const params = encodeEntriesRequest(tc.draw(request));
    const field = tc.draw(gs.sampledFrom(["min", "max", "limit", "order"] as const));
    params.set(field, tc.draw(invalidValue[field]));

    expect(parseEntriesRequest(params)).toBeUndefined();
  });
});

test("a request that names nothing reads the newest 50 entries", () => {
  expect(parseEntriesRequest(new URLSearchParams())).toStrictEqual({
    minEntryId: undefined,
    maxEntryId: undefined,
    order: "descending",
    limit: 50,
  });
});
