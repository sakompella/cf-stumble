import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenIn } from "./page/token.ts";

describe("page fuzz send tokens", () => {
  it("reads the whole token, so send 1 is not counted in send 12", () => {
    const text =
      "Reply with the single word ok. Ignore the rest. fz898838510-mwb6qhvx-12\n# heading";

    assert.equal(tokenIn(text), "fz898838510-mwb6qhvx-12");
    assert.notEqual(tokenIn(text), "fz898838510-mwb6qhvx-1");
  });

  it("reads no token from a draft", () => {
    assert.equal(tokenIn("</script><script>alert(1)</script> 644"), "");
  });
});
