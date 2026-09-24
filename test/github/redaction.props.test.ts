import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { redactCredentials } from "../../src/github/index.js";

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

test("redacts documented tokens next to non-word delimiters and reaches a fixpoint", () => {
  hegel.test((tc) => {
    const tokenPrefix = tc.draw(prefix);
    const body = tc.draw(tokenPrefix === "github_pat_" ? fineGrainedTokenBody : tokenBody);
    const token = `${tokenPrefix}${body}`;
    const message = `${tc.draw(boundary)}${tc.draw(wordGlue)}${token}${tc.draw(wordGlue)}${tc.draw(boundary)}`;
    const redacted = redactCredentials(message);

    expect(redacted).not.toContain(token);
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});

test("redacts arbitrary opaque known tokens", () => {
  hegel.test((tc) => {
    const token = tc.draw(knownToken);
    const message = `command failed: ${token}`;
    const redacted = redactCredentials(message, token);

    // Uppercase known-token generation keeps the token distinct from the lowercase replacement
    // marker, so this checks that the exact opaque value is gone rather than the marker itself.
    expect(redacted).not.toContain(token);
    expect(redactCredentials(redacted, token)).toBe(redacted);
  });
});

test("redacts generated HTTPS URL userinfo credentials", () => {
  hegel.test((tc) => {
    const user = tc.draw(urlPart);
    const secret = `secret-${tc.draw(urlPart)}`;
    const message = `remote: https://${user}:${secret}@github.com/owner/repo.git failed`;
    const redacted = redactCredentials(message);

    expect(redacted).not.toContain(user);
    expect(redacted).not.toContain(secret);
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});
