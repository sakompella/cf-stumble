import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { OWNER_PAGE_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";

test("the script the browser receives parses as JavaScript", () => {
  assert.ok(OWNER_PAGE_SCRIPT_SOURCE.length > 0);
  assert.doesNotThrow(() => new Script(OWNER_PAGE_SCRIPT_SOURCE));
});
