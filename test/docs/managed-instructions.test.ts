import { expect, test } from "vitest";
import { MANAGED_AGENT_INSTRUCTIONS } from "../../src/project-provision.js";

/**
 * ADR-0039 grants the shared workspace a shell, development tools, and unrestricted egress, and
 * pays for it with one instruction it quotes verbatim. That instruction is only worth anything if
 * the file cf-stumble actually writes still contains it, and nothing about editing either side
 * forces the other to change.
 *
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const adrFiles = import.meta.glob(
  "../../docs/agents/adr/0039-treat-the-workspace-as-a-development-machine.md",
  { eager: true, query: "?raw", import: "default" },
);

/** The ADR wraps its quoted instruction across lines; the written file wraps differently. */
function unwrapped(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function quotedInstruction(adr: string): string {
  const quoted = adr
    .split("\n")
    .filter((line) => line.startsWith("> `git`") || line.startsWith("> and the repository"));

  return unwrapped(quoted.map((line) => line.slice(2)).join(" "));
}

test("the managed instructions still carry the instruction ADR-0039 requires", () => {
  const adr = Object.values(adrFiles)[0];

  if (adr === undefined) {
    throw new Error("ADR-0039 must exist for this check to mean anything");
  }

  const instruction = quotedInstruction(adr);

  expect(instruction).toContain("Never print or commit authentication tokens.");
  expect(unwrapped(MANAGED_AGENT_INSTRUCTIONS)).toContain(instruction);
});
