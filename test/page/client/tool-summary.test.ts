import { expect, test } from "vitest";
import { toolSummaryText } from "../../../src/page/client/tool-summary.js";

test("a command shows as the command, without its JSON or its options", () => {
  expect(
    toolSummaryText("bash", { command: "pnpm verify", timeout: 40, backend: "container" }),
  ).toBe("bash $ pnpm verify");
});

test("a long multi-line command is cut to one line", () => {
  const shown = toolSummaryText("bash", { command: `echo a\n${"x".repeat(300)}` });

  expect(shown).not.toContain("\n");
  expect(shown.length).toBeLessThanOrEqual(165);
  expect(shown.endsWith("…")).toBe(true);
});

test("other tools show their plain arguments, not JSON", () => {
  expect(toolSummaryText("read", { path: "src/a.ts", limit: 20 })).toBe(
    "read path: src/a.ts, limit: 20",
  );
  expect(toolSummaryText("edit", { path: "a", edits: [{ oldText: "x" }] })).toBe("edit path: a");
  expect(toolSummaryText("ls", {})).toBe("ls");
});
