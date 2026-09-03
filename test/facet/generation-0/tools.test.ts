import { expect, test } from "vitest";
import {
  applyUniqueEdit,
  GENERATION_0_TOOLS,
  planToolCall,
} from "../../../src/facet/generation-0/index.js";

test("plans one workspace request for each tool the catalogue offers", () => {
  expect(planToolCall("read_file", { path: "src/app.ts" })).toEqual({
    kind: "read-file",
    path: "src/app.ts",
  });
  expect(planToolCall("write_file", { path: "a.txt", content: "hi" })).toEqual({
    kind: "write-file",
    path: "a.txt",
    content: "hi",
  });
  expect(planToolCall("edit_file", { path: "a.txt", old_text: "a", new_text: "b" })).toEqual({
    kind: "edit-file",
    path: "a.txt",
    oldText: "a",
    newText: "b",
  });
  expect(planToolCall("list_files", { path: "" })).toEqual({ kind: "list-files", path: "" });
  expect(planToolCall("run_command", { command: "check" })).toEqual({
    kind: "run-command",
    command: "check",
  });
  expect(planToolCall("git_diff", {})).toEqual({ kind: "git-diff" });
});

test("refuses a tool it does not offer and arguments it cannot use", () => {
  expect(planToolCall("deploy", { target: "production" })).toEqual({
    kind: "unknown-tool",
    name: "deploy",
  });
  expect(planToolCall("write_file", { path: "a.txt" })).toEqual({
    kind: "invalid-arguments",
    name: "write_file",
    detail: "path and content must both be strings",
  });
  expect(planToolCall("edit_file", { path: "a.txt", old_text: "", new_text: "b" })).toEqual({
    kind: "invalid-arguments",
    name: "edit_file",
    detail: "old_text must not be empty",
  });
});

test("every offered tool plans a request rather than reporting an unknown tool", () => {
  for (const tool of GENERATION_0_TOOLS) {
    expect(planToolCall(tool.name, {}).kind).not.toBe("unknown-tool");
  }
});

test("edits one exact occurrence and refuses a missing or repeated match", () => {
  expect(applyUniqueEdit("const value = 1;", "1", "2")).toEqual({
    ok: true,
    content: "const value = 2;",
  });
  expect(applyUniqueEdit("a b", "c", "d")).toEqual({ ok: false, reason: "not-found" });
  expect(applyUniqueEdit("a a", "a", "b")).toEqual({ ok: false, reason: "not-unique" });
});
