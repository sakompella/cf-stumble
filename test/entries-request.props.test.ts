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
