import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertAtMost,
  assertClickRefused,
  assertSame,
  byId,
  completeTurn,
  openTool,
  PROJECT_BUTTON,
  readBox,
  readConversation,
  readLayout,
  readPageMetrics,
  readProjectList,
  readScroll,
  readThread,
  readTools,
  readGeneration,
  tabUntil,
  TOOL_DISCLOSURE,
  waitForText,
  waitForThreadOk,
  type HarnessCase,
} from "../harness.mjs";

const PHONE = { width: 390, height: 720 } as const;
const SHORT_PHONE = { width: 390, height: 640 } as const;
const DRAWER_CONTROLS = [
  ID.candidateCommitInput,
  ID.submitCandidateButton,
  ID.activateLabelInput,
  ID.activateButton,
  ID.rollbackLabelInput,
  ID.rollbackButton,
] as const;

async function assertDrawerControls(
  page: Parameters<typeof tabUntil>[0],
  viewportHeight: number,
): Promise<number> {
  const focused: string[] = [];
  for (const control of DRAWER_CONTROLS) {
    const stops = await tabUntil(page, (stop) => stop.id === control);
    const stop = stops.at(-1);
    const box = await readBox(page, byId(control));
    assert(stop !== undefined && stop.visible, `${control} did not receive visible keyboard focus`);
    assertSame(box.visible, true, `${control} visible box`);
    assert(
      box.top >= 0 && box.bottom <= viewportHeight,
      `${control} was not scrolled into the phone viewport`,
    );
    focused.push(control);
  }
  return focused.length;
}

export const CASES: readonly HarnessCase[] = [
  {
    id: "NAR-1",
    title: "phone width stacks panels without overflow",
    rank: "should",
    scenario: "ready",
    viewport: PHONE,
    run: async ({ page }) => {
      await waitForThreadOk(page);
      const layout = await readLayout(page);
      const conversation = await readBox(page, byId(ID.conversation));
      const prompt = await readBox(page, byId(ID.promptInput));
      const send = await readBox(page, byId(ID.sendTurnButton));
      const metrics = await readPageMetrics(page);

      assertAtLeast(layout.sidebarWidth, 1, "phone sidebar width");
      assertAtLeast(layout.conversationWidth, 1, "phone conversation width");
      assert(layout.sidebarBottom <= layout.conversationTop, "phone panels overlap vertically");
      assertAtLeast(conversation.width, metrics.viewportWidth - 40, "phone conversation width");
      assertAtMost(conversation.left, 20, "phone conversation left edge");
      assertSame(prompt.visible, true, "prompt visibility on a phone");
      assertSame(send.visible, true, "Send visibility on a phone");
      assertAtMost(metrics.horizontalOverflow, 1, "phone horizontal document overflow");

      return `${layout.sidebarWidth}px sidebar stacks above ${layout.conversationWidth}px conversation; prompt and Send stayed visible with ${metrics.horizontalOverflow}px horizontal overflow`;
    },
  },
  {
    id: "NAR-2",
    title: "phone sidebar can hide and restore without data loss",
    rank: "should",
    scenario: "ready",
    viewport: PHONE,
    run: async ({ page }) => {
      await waitForThreadOk(page);
      const beforeProjects = await readProjectList(page);
      const beforeThread = await readThread(page);
      const beforeConversation = await readConversation(page);

      await page.click(byId(ID.sidebarToggle));
      const hidden = await readLayout(page);
      const hiddenConversation = await readConversation(page);
      const restore = await readBox(page, byId(ID.sidebarToggle));
      await assertClickRefused(page, PROJECT_BUTTON, "a hidden phone project button");
      assertSame(hidden.sidebarWidth, 0, "collapsed phone sidebar width");
      assertSame(hidden.toggleExpanded, "false", "collapsed phone toggle state");
      assertSame(hidden.toggleLabel.trim(), "Show projects", "collapsed phone toggle label");
      assertSame(restore.visible, true, "visible phone restore control");
      assertSame(
        hiddenConversation.allText,
        beforeConversation.allText,
        "conversation while hidden",
      );

      await page.click(byId(ID.sidebarToggle));
      const restored = await readLayout(page);
      const afterProjects = await readProjectList(page);
      const afterThread = await readThread(page);
      assertAtLeast(restored.sidebarWidth, 1, "restored phone sidebar width");
      assertSame(restored.toggleExpanded, "true", "restored phone toggle state");
      assertSame(restored.toggleLabel.trim(), "Hide", "restored phone toggle label");
      assertSame(
        afterProjects.projects.length,
        beforeProjects.projects.length,
        "restored project count",
      );
      assertSame(
        afterProjects.selected[0] ?? "",
        beforeProjects.selected[0] ?? "",
        "restored selected project",
      );
      assertSame(afterThread.project, beforeThread.project, "restored conversation project");
      assertSame(
        (await readConversation(page)).allText,
        beforeConversation.allText,
        "conversation after restore",
      );

      return `hiding removed the ${beforeProjects.projects.length}-project sidebar, kept the transcript, and restoring returned ${restored.sidebarWidth}px with the same ${afterProjects.selected[0]} selection`;
    },
  },
  {
    id: "NAR-3",
    title: "long transcript and drawer stay operable on a short phone",
    rank: "should",
    scenario: "ready",
    viewport: SHORT_PHONE,
    run: async ({ page }) => {
      await completeTurn(page, "Run the configured check");
      await openTool(page, 2);
      const transcript = await readScroll(page, ID.messageList);
      const output = await readTools(page);
      const messageBox = await readBox(page, byId(ID.messageList));
      const outputBox = await readBox(page, `${TOOL_DISCLOSURE}[open] .tool-output`);
      const metrics = await readPageMetrics(page);
      assertSame(transcript.scrollable, true, "internal transcript scrolling on a short phone");
      assertAtMost(
        transcript.height,
        metrics.viewportHeight * 0.6 + 2,
        "short-phone transcript height",
      );
      assertAtLeast(output[2]?.outputLength ?? 0, 1, "large command output");
      assert(outputBox.visible, "large command output has no visible box");
      assert(
        outputBox.left >= messageBox.left - 1,
        "command output escapes the transcript left edge",
      );
      assert(
        outputBox.right <= messageBox.right + 1,
        "command output escapes the transcript right edge",
      );
      await page.click(byId(ID.sendTurnButton));
      const clickedSend = await readBox(page, byId(ID.sendTurnButton));
      assert(
        clickedSend.visible && clickedSend.top >= 0 && clickedSend.bottom <= metrics.viewportHeight,
        "Send is not inside the short phone viewport after its real click",
      );
      await waitForText(page, ID.turnState, "type a prompt first");
      await page.click(`${byId(ID.generationDrawer)} summary`);
      assertSame(
        (await readGeneration(page)).drawerOpen,
        true,
        "generation drawer after opening on a short phone",
      );
      const focused = await assertDrawerControls(page, metrics.viewportHeight);
      assertAtMost(
        (await readPageMetrics(page)).horizontalOverflow,
        1,
        "short-phone horizontal overflow",
      );
      return `the transcript scrolled at ${transcript.height}px with ${output[2]?.outputLength ?? 0} command characters; Send answered "type a prompt first" and all ${focused} drawer controls received visible keyboard focus`;
    },
  },
];
