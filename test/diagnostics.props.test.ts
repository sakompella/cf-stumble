import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test, vi } from "vitest";
import { logEvent, logRedactedCause } from "../src/diagnostics.js";

/**
 * Whatever a string field holds, a GitHub token or an Access JWT inside it never reaches the log.
 * Fields are meant to be ids and codes, but a code built from text a tool printed is still text,
 * so the logger redacts every string rather than trusting its caller.
 */
const githubToken = gs
  .text({
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    minSize: 20,
    maxSize: 40,
  })
  .map((body) => `ghp_${body}`);

const jwt = gs
  .text({
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    minSize: 8,
    maxSize: 30,
  })
  .map((part) => `eyJ${part}.eyJ${part}.${part}`);

const segmentBody = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  minSize: 8,
  maxSize: 400,
});

const surrounding = gs.text({ alphabet: 'abc -:/="', maxSize: 20 });

test("no credential or JWT inside a string field reaches the log", () => {
  hegel.test((tc) => {
    const secret = tc.draw(gs.oneOf(githubToken, jwt));
    const value = `${tc.draw(surrounding)}${secret}${tc.draw(surrounding)}`;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", "github-credential.install", { detail: value, source: "configured-token" });

    const written = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(written).not.toContain(secret);
    expect(written).toContain("configured-token");
  });
});

/**
 * A thrown cause is cut to a fixed length. Wherever that cut falls relative to a JWT inside the
 * cause, no segment of the token reaches the log.
 */
test("no segment of a JWT inside a thrown cause reaches the log, wherever the cause is cut", () => {
  hegel.test((tc) => {
    const header = `eyJ${tc.draw(segmentBody)}`;
    const payload = `eyJ${tc.draw(segmentBody)}`;
    const signature = `sig${tc.draw(segmentBody)}`;
    const leading = "x".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 600 })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    logRedactedCause(
      "access-keys.load: key-service-unavailable",
      new Error(`${leading}${header}.${payload}.${signature}`),
    );

    const written = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(written).toContain("access-keys.load: key-service-unavailable");

    for (const segment of [header, payload, signature]) expect(written).not.toContain(segment);
  });
});
