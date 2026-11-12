import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ISOLATE_PROGRAMS } from "../src/workspace/project/isolate-programs.ts";
import { JUST_BASH_COMMAND_NAMES } from "./just-bash-commands.mts";

describe("isolate programs", () => {
  it("come from the commands the shell module set registers", () => {
    const registered = new Set(JUST_BASH_COMMAND_NAMES);

    assert.deepEqual(
      [...ISOLATE_PROGRAMS].filter((program) => !registered.has(program)),
      ["cd", "test", "curl"],
    );
  });
});
