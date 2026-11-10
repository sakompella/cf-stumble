import { expect, test } from "vitest";
import { parseEntriesRequest } from "../src/entries-request.js";

test.each(["abc", "", "-1", "1.5", "1e2", "1e300", "0x10", "1234567890123456"])(
  "an entries request with the limit %j is refused, not given the default",
  (limit) => {
    expect(parseEntriesRequest(new URLSearchParams({ limit }))).toBeUndefined();
  },
);

test("an entries request without a limit gets the default", () => {
  expect(parseEntriesRequest(new URLSearchParams())?.limit).toBe(50);
});
