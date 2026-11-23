import { awaitWithContext } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessScenario } from "./fixtures.mjs";

export const TOOL_OUTPUT = ["tests: 12 passed\n", "lint: clean\n"] as const;

export const RENDERED_REPLY = [
  "Here is what changes; the heading was <b>Repositories</b>:",
  "",
  "| file | change |",
  "| --- | --- |",
  "| src/sidebar.ts | heading text |",
  "",
  "```ts",
  'const heading = "Projects";',
  "```",
].join("\n");

export const DIFF_COMMAND = "git diff";

export const DIFF_OUTPUT = [
  "diff --git a/src/sidebar.ts b/src/sidebar.ts",
  "index 3b18e51..a9c2f47 100644",
  "--- a/src/sidebar.ts",
  "+++ b/src/sidebar.ts",
  "@@ -1,3 +1,3 @@",
  " export const order = 1;",
  '-export const heading = "Repositories";',
  '+export const heading = "Projects";',
  " export const width = 18;",
  "",
].join("\n");

const EDITED_PATH = "src/footer.ts";

const EDIT_PATCH = [
  `--- ${EDITED_PATH}`,
  `+++ ${EDITED_PATH}`,
  "@@ -1,2 +1,2 @@",
  '-export const footer = "old footer";',
  '+export const footer = "new footer";',
  " export const year = 2026;",
  "",
].join("\n");

export const EDIT_ARGUMENTS = { path: EDITED_PATH };

const editStub = defineTool({
  name: "edit",
  description: "Edit a file in the project",
  parameters: obj({ path: str() }),
  execute: async ({ path }) => {
    await Promise.resolve();

    return {
      output: [{ type: "text", text: `Successfully replaced 1 block(s) in ${path}.` }],
      details: { patch: EDIT_PATCH },
    };
  },
});

export type Barrier = {
  reached: boolean;
  held: boolean;
  release: () => void;
  released: Promise<void>;
};

export function freshBarrier(): Barrier {
  const barrier = { reached: false, held: false, release: (): void => undefined };

  const released = new Promise<void>((resolve) => {
    barrier.release = () => {
      barrier.held = false;
      resolve();
    };
  });

  return Object.assign(barrier, { released });
}

export async function preparing(barrier: Barrier): Promise<undefined> {
  if (barrier.held) {
    barrier.reached = true;
    await barrier.released;
  }

  return undefined;
}

export function stubTools(scenario: HarnessScenario, barrier: Barrier): Extension {
  const bash = defineTool({
    name: "bash",
    description: "Run a shell command in the project",
    parameters: obj({ command: str() }),
    execute: async (_args, api, toolContext) => {
      const [first, second] = scenario === "rendered" ? [DIFF_OUTPUT, ""] : TOOL_OUTPUT;
      api.output(first);

      if (scenario === "ready-paused") {
        barrier.reached = true;
        barrier.held = true;
        await awaitWithContext(barrier.released, toolContext);
      }

      await sleep(150);
      api.output(second);

      return {};
    },
  });

  return defineExtension({ name: "stub", tools: [bash, editStub] });
}
