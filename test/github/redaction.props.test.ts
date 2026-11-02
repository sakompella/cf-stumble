import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { redactCredentials, REDACTED } from "../../src/github/index.js";
import { containsCredential } from "../../src/github/redaction.js";

const prefix = gs.sampledFrom(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]);

const tokenBody = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  minSize: 16,
  maxSize: 48,
});

const fineGrainedTokenBody = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",
  minSize: 16,
  maxSize: 48,
});

const boundary = gs.sampledFrom(["=", '"', "(", ")", ":", "/", "@", "\n"]);

const wordGlue = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",
  minSize: 1,
  maxSize: 2,
});

const knownToken = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
  minSize: 1,
  maxSize: 30,
});

const urlPart = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
  minSize: 1,
  maxSize: 20,
});

const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const nearMiss = gs.oneOf(
  gs.sampledFrom([
    "ghost",
    "ghp",
    "gh",
    "github",
    "https://github.com/o/r",
    "https://github.com/o/r@v1",
    "repository",
    "not found",
  ]),
  gs
    .tuples(
      gs.sampledFrom(["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]),
      gs.text({ alphabet: alphanumeric, maxSize: 15 }),
    )
    .map(([tokenPrefix, body]) => `${tokenPrefix}${body}`),
  gs.text({ alphabet: `${alphanumeric}_`, maxSize: 15 }).map((body) => `github_pat_${body}`),
  gs.text({ alphabet: alphanumeric, minSize: 16, maxSize: 30 }).map((body) => `ghx_${body}`),
);

const separator = gs.sampledFrom([" ", "\n", ":", "/", "(", ")", ","]);

test("redacts documented tokens next to non-word delimiters and reaches a fixpoint", () => {
  hegel.test((tc) => {
    const tokenPrefix = tc.draw(prefix);
    const body = tc.draw(tokenPrefix === "github_pat_" ? fineGrainedTokenBody : tokenBody);
    const token = `${tokenPrefix}${body}`;
    const message = `${tc.draw(boundary)}${tc.draw(wordGlue)}${token}${tc.draw(wordGlue)}${tc.draw(boundary)}`;
    const redacted = redactCredentials(message);

    expect(containsCredential(message)).toBe(true);
    expect(containsCredential(redacted)).toBe(false);
    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain(token);
    expect(redacted.replaceAll(REDACTED, "")).not.toContain(body.slice(-6));
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});

test("redacts arbitrary opaque known tokens", () => {
  hegel.test((tc) => {
    const token = tc.draw(knownToken);
    const message = `command failed: ${token}`;
    const redacted = redactCredentials(message, token);

    expect(redacted).not.toContain(token);
    expect(redactCredentials(redacted, token)).toBe(redacted);
  });
});

test("redacts generated HTTPS URL userinfo credentials", () => {
  hegel.test((tc) => {
    const user = tc.draw(gs.oneOf(urlPart, gs.just("x-access-token")));
    const secret = `secret-${tc.draw(urlPart)}`;
    const message = `remote: https://${user}:${secret}@github.com/owner/repo.git failed`;
    const redacted = redactCredentials(message);

    expect(redacted).toBe(`remote: https://${REDACTED}@github.com/owner/repo.git failed`);
    expect(redacted).not.toContain(user);
    expect(redacted).not.toContain(secret);
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});

test("text with no token shape in it is returned unchanged", () => {
  hegel.test((tc) => {
    const pieces = tc.draw(gs.arrays(nearMiss, { minSize: 1, maxSize: 6 }));

    const separators = tc.draw(
      gs.arrays(separator, { minSize: pieces.length, maxSize: pieces.length }),
    );

    const text = pieces
      .map((piece, index) => `${index === 0 ? "" : separators[index]}${piece}`)
      .join("");

    expect(redactCredentials(text)).toBe(text);
    expect(containsCredential(text)).toBe(false);
  });
});
