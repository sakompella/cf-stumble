import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { containsCredential, redactCredentials } from "../../src/github/index.js";

const prefix = gs.sampledFrom(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]);

const tokenBody = gs.text({
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  minSize: 16,
  maxSize: 48,
});

const surrounding = gs.text({ alphabet: "abc XYZ012:./-", maxSize: 40 });

test("redaction removes every generated documented token and reaches a fixpoint", () => {
  hegel.test((tc) => {
    const token = `${tc.draw(prefix)}${tc.draw(tokenBody)}`;
    const message = `${tc.draw(surrounding)} ${token} ${tc.draw(surrounding)}`;
    const redacted = redactCredentials(message);

    expect(redacted).not.toContain(token);
    expect(containsCredential(redacted)).toBe(false);
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});
