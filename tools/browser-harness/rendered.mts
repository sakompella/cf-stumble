import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

export const RENDERED_REPLY = [
  "Here is what changes:",
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

export const editStub = defineTool({
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
