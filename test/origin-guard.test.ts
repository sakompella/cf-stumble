import { beforeEach, expect, test, vi } from "vitest";
import { crossOriginRefusal } from "../src/origin-guard.js";

const ORIGIN = "https://cf-stumble.test";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const send = (method: string, headers: HeadersInit = {}) =>
  crossOriginRefusal(new Request(`${ORIGIN}/api/status`, { method, headers }));

test.each([
  ["a foreign Origin", { origin: "https://elsewhere.test" }],
  ["a null Origin", { origin: "null" }],
  ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
])("a POST with %s is refused 403", async (_name, headers) => {
  const refusal = send("POST", headers);

  expect(refusal?.status).toBe(403);
  await expect(refusal?.json()).resolves.toEqual({
    ok: false,
    error: { code: "cross-origin-request" },
  });
});

test.each([
  ["its own Origin", { origin: ORIGIN, "sec-fetch-site": "same-origin" }],
  ["no Origin headers", {}],
])("a POST with %s passes", (_name, headers) => {
  expect(send("POST", headers)).toBeUndefined();
});

test("a GET or HEAD passes whatever its origin", () => {
  for (const method of ["GET", "HEAD"]) {
    expect(
      send(method, { origin: "https://elsewhere.test", "sec-fetch-site": "cross-site" }),
    ).toBeUndefined();
  }
});
