import { timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ownerGateRefusal } from "../src/owner-gate.js";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH } from "../src/orb-protocol.js";

const EXEMPT_PATHS: readonly string[] = ["/health", ORB_PROVIDER_PATH, ORB_COMPUTERD_PATH];

beforeAll(() => {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (a: ArrayBuffer, b: ArrayBuffer) =>
      timingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
  vi.restoreAllMocks();
});

function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);

  return `Basic ${btoa(String.fromCodePoint(...bytes))}`;
}

const secret = gs.text({ minSize: 1, maxSize: 40 });

const username = gs.oneOf(
  gs.just("aditya"),
  gs.text({ maxSize: 12 }).filter((name) => !name.includes(":")),
);

const host = gs.text({ alphabet: "abcxyz0123456789", minSize: 1, maxSize: 12 });

const originOf = gs
  .tuples(
    gs.sampledFrom(["http", "https"]),
    host,
    gs.optional(gs.integers({ minValue: 1, maxValue: 65535 })),
  )
  .map(
    ([scheme, name, port]) =>
      new URL(`${scheme}://${name}.test${port === null ? "" : `:${port}`}`).origin,
  );

const method = gs.sampledFrom(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const path = gs.sampledFrom([
  "/",
  "/api/status",
  "/api/workspace/reset",
  "/api/projects/p/messages",
  "/x",
]);

test("a request passes the credential check exactly when it names aditya and the secret", async () => {
  await hegel.testAsync(async (tc) => {
    const expected = tc.draw(secret);
    const name = tc.draw(username);
    const password = tc.draw(gs.oneOf(gs.just(expected), gs.text({ maxSize: 40 })));

    const request = new Request(`https://cf-stumble.test${tc.draw(path)}`, {
      headers: { authorization: basic(name, password) },
    });

    const refusal = await Effect.runPromise(ownerGateRefusal(request, expected));
    const isOwner = name === "aditya" && password === expected;

    expect(refusal?.status).toBe(isOwner ? undefined : 401);
  });
});

test("a header that is not a well-formed Basic credential is refused with a Basic challenge", async () => {
  await hegel.testAsync(async (tc) => {
    const authorization = tc.draw(
      gs.optional(gs.text({ alphabet: "Basic Bearer=:!+/abc012", maxSize: 30 })),
    );

    const headers: HeadersInit = authorization === null ? {} : { authorization };

    const refusal = await Effect.runPromise(
      ownerGateRefusal(
        new Request("https://cf-stumble.test/api/status", { headers }),
        tc.draw(secret),
      ),
    );

    expect(refusal?.status).toBe(401);
    expect(refusal?.headers.get("www-authenticate")?.split(" ")[0]).toBe("Basic");
    expect(refusal?.headers.get("www-authenticate")).toMatch(/realm="cf-stumble"/u);
  });
});

test("without the secret every route but the exempt GETs answers 503, and an exempt GET never needs a credential", async () => {
  await hegel.testAsync(async (tc) => {
    const password = tc.draw(gs.oneOf(gs.sampledFrom([undefined, ""]), secret));
    const requestMethod = tc.draw(method);
    const requestPath = tc.draw(gs.oneOf(path, gs.sampledFrom(EXEMPT_PATHS)));
    const authorization = tc.draw(gs.optional(gs.tuples(username, gs.text({ maxSize: 20 }))));

    const headers: HeadersInit =
      authorization === null ? {} : { authorization: basic(...authorization) };

    const refusal = await Effect.runPromise(
      ownerGateRefusal(
        new Request(`https://cf-stumble.test${requestPath}`, { method: requestMethod, headers }),
        password,
      ),
    );

    if (requestMethod === "GET" && EXEMPT_PATHS.includes(requestPath)) {
      expect(refusal).toBeUndefined();
    } else if (password === undefined || password === "") {
      expect(refusal?.status).toBe(503);
    } else {
      const isOwner =
        authorization !== null && authorization[0] === "aditya" && authorization[1] === password;

      expect(refusal?.status).toBe(isOwner ? undefined : 401);
    }
  });
});

test("an authorized state-changing request is refused 403 exactly when a browser says it came from another origin", async () => {
  await hegel.testAsync(async (tc) => {
    const own = tc.draw(originOf);
    const requestMethod = tc.draw(method);
    const origin = tc.draw(gs.oneOf(gs.just(null), gs.just(own), gs.just("null"), originOf));

    const fetchSite = tc.draw(
      gs.optional(gs.sampledFrom(["same-origin", "same-site", "cross-site", "none"])),
    );

    const headers = new Headers({ authorization: basic("aditya", "pw") });

    if (origin !== null) headers.set("origin", origin);

    if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);

    const refusal = await Effect.runPromise(
      ownerGateRefusal(
        new Request(`${own}${tc.draw(path)}`, { method: requestMethod, headers }),
        "pw",
      ),
    );

    const mutation = requestMethod !== "GET" && requestMethod !== "HEAD";

    const foreign =
      (origin !== null && origin !== own) || (fetchSite !== null && fetchSite !== "same-origin");

    expect(refusal?.status).toBe(mutation && foreign ? 403 : undefined);
  });
});
