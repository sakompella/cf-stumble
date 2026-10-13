import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertSame,
  focusDocument,
  readFocus,
  readFocusedAccessibleNode,
  type HarnessCase,
} from "../harness.mjs";

const EXPECTED = [
  { id: ID.refreshStatusButton, name: "Refresh status" },
  { id: "", name: "Generation controls" },
  { id: ID.sidebarToggle, name: "Hide" },
  { id: "octocat-hello-world", name: "hello-world" },
  { id: "harness", name: "harness" },
  { id: ID.authorizeButton, name: "Authorize GitHub" },
  { id: ID.completeAuthorizationButton, name: "I authorized it" },
  { id: ID.chatgptConnectButton, name: "Connect ChatGPT" },
  { id: ID.connectRepositoryInput, name: "REPOSITORY URL" },
  { id: ID.connectButton, name: "Connect" },
  { id: ID.promptInput, name: "PROMPT" },
  { id: ID.sendTurnButton, name: "Send turn" },
  { id: ID.freshThreadButton, name: "Start fresh thread" },
] as const;

export const CASES: readonly HarnessCase[] = [
  {
    id: "KEY-1",
    title: "closed-page tab order is complete and visible",
    rank: "should",
    scenario: "ready",
    run: async ({ page }) => {
      await focusDocument(page);
      const seen: string[] = [];

      for (const [index, expected] of EXPECTED.entries()) {
        await page.press("Tab");
        const focus = await readFocus(page);
        const ax = await readFocusedAccessibleNode(page);
        assert(focus.visible, `tab stop ${expected.name} is not visible`);
        assert(
          focus.outlineStyle !== "none" && focus.outlineWidth >= 2,
          `tab stop ${expected.name} has no visible focus outline`,
        );

        if (expected.id === "octocat-hello-world" || expected.id === "harness") {
          assertSame(focus.projectId, expected.id, `project at tab stop ${index + 1}`);
          assert(
            ax.name.startsWith(expected.name),
            `project ${expected.name} accessible name: ${ax.name}`,
          );
        } else {
          assertSame(ax.name, expected.name, `accessible name at tab stop ${index + 1}`);

          if (expected.id !== "") assertSame(focus.id, expected.id, `${expected.name} focused id`);
        }

        seen.push(expected.name);
      }

      assertAtLeast(seen.length, 13, "primary keyboard stops");

      return `${seen.length} primary controls were reached in order with a visible 2px focus outline`;
    },
  },
];
