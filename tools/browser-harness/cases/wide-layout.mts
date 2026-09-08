import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertAtMost,
  assertIncludes,
  assertNonEmpty,
  assertSame,
  byId,
  completeTurn,
  HARNESS_SELF_PROJECT_ID,
  openTool,
  projectButton,
  readBox,
  readConversation,
  readGeneration,
  readLayout,
  readPageMetrics,
  readProjectList,
  readScroll,
  readThread,
  selectRequestsLike,
  waitForTranscriptText,
  waitForThreadOk,
  type HarnessCase,
} from "../harness.mjs";

function assertVisible(box: Awaited<ReturnType<typeof readBox>>, what: string): void {
  assert(
    box.present && box.visible,
    `${what}: expected a visible box, read ${JSON.stringify(box)}`,
  );
}

export const CASES: readonly HarnessCase[] = [
  {
    id: "WID-1",
    title: "populated desktop is a bounded two-column page",
    rank: "must",
    scenario: "ready",
    viewport: { width: 1600, height: 1000 },
    run: async ({ page }) => {
      const layout = await readLayout(page);
      const projects = await readProjectList(page);
      const generation = await readGeneration(page);
      const thread = await readThread(page);
      const conversation = await readConversation(page);
      const metrics = await readPageMetrics(page);
      const content = await readBox(page, byId(ID.layout));

      assertSame(conversation.title, "cf-stumble", "the document title");
      assertNonEmpty(generation.activeLabel, "the active generation label");
      assertNonEmpty(generation.activeCommit, "the active generation commit");
      assertSame(projects.projects.length, 2, "populated project count");
      assertNonEmpty(conversation.allText, "the selected conversation");
      assertSame(thread.state, "ok", "the selected thread state");
      assertAtLeast(layout.sidebarWidth, 286, "the sidebar width");
      assertAtMost(layout.sidebarWidth, 290, "the sidebar width");
      assertAtMost(
        layout.sidebarRight,
        layout.conversationLeft,
        "the sidebar/conversation boundary",
      );
      assert(
        layout.conversationWidth > layout.sidebarWidth,
        "the conversation is wider than the sidebar",
      );
      assertAtMost(content.width, 1248, "the combined content width");
      assertAtLeast(metrics.bodyLeft, 100, "the content's distance from the window edge");
      assertAtMost(metrics.horizontalOverflow, 1, "horizontal document overflow");

      return `cf-stumble rendered ${projects.projects.length} projects and ${conversation.messages} conversation entries in ${layout.sidebarWidth.toFixed(1)}px and ${layout.conversationWidth.toFixed(1)}px columns with ${metrics.horizontalOverflow}px overflow`;
    },
  },
  {
    id: "WID-2",
    title: "desktop collapse expands conversation and restores layout",
    rank: "should",
    scenario: "ready",
    viewport: { width: 1440, height: 900 },
    run: async ({ page }) => {
      const before = await readLayout(page);
      const saved = await readConversation(page);
      const selected = await readProjectList(page);
      await page.click(byId(ID.sidebarToggle));
      const hidden = await readLayout(page);
      assertSame(hidden.sidebarWidth, 0, "the collapsed sidebar width");
      assertSame(hidden.toggleExpanded, "false", "the collapsed toggle state");
      assertIncludes(hidden.toggleLabel, "Show projects", "the collapsed toggle label");
      assert(
        hidden.conversationWidth > before.conversationWidth,
        "the conversation width after collapse",
      );
      assertNonEmpty(saved.allText, "the conversation before collapse");
      assertSame(selected.selected.length, 1, "the selected project before collapse");

      await page.click(byId(ID.sidebarToggle));
      const restored = await readLayout(page);
      const restoredProjects = await readProjectList(page);
      const after = await readConversation(page);
      assertAtLeast(restored.sidebarWidth, 1, "the restored sidebar width");
      assertSame(restored.toggleExpanded, "true", "the restored toggle state");
      assertIncludes(restored.toggleLabel, "Hide", "the restored toggle label");
      assertAtMost(
        restored.sidebarRight,
        restored.conversationLeft,
        "the restored column boundary",
      );
      assertSame(after.allText, saved.allText, "the conversation after collapse and restore");
      assertSame(
        restoredProjects.selected.join(","),
        selected.selected.join(","),
        "the selected project after restore",
      );

      return `the conversation grew from ${before.conversationWidth.toFixed(1)}px to ${hidden.conversationWidth.toFixed(1)}px while hidden, then restored with ${restoredProjects.selected[0] ?? "no"} still selected`;
    },
  },
  {
    id: "WID-3",
    title: "long transcript and open controls fit one desktop view",
    rank: "should",
    scenario: "long-line",
    viewport: { width: 1600, height: 1000 },
    run: async ({ page }) => {
      const before = await readPageMetrics(page);
      await completeTurn(page, "Run the build");
      await openTool(page, 0);
      const scroll = await readScroll(page, ID.messageList);
      const output = await readConversation(page);
      const metrics = await readPageMetrics(page);
      const refresh = await readBox(page, byId(ID.refreshStatusButton));
      const send = await readBox(page, byId(ID.sendTurnButton));
      const layout = await readLayout(page);

      assertSame(scroll.scrollable, true, "the transcript's internal scrolling");
      assertAtMost(scroll.height, metrics.viewportHeight * 0.6 + 2, "the transcript height");
      assertNonEmpty(output.allText, "the long-turn transcript");
      assertVisible(refresh, "Refresh status");
      assertVisible(send, "Send turn");
      assertAtMost(
        metrics.scrollHeight - before.scrollHeight,
        metrics.viewportHeight - 1,
        "page growth after long output",
      );
      assertAtMost(metrics.horizontalOverflow, 1, "horizontal document overflow");
      assertAtMost(layout.sidebarRight, layout.conversationLeft, "the desktop column boundary");

      await page.click(`${byId(ID.generationDrawer)} summary`);
      const controls = [
        ID.candidateCommitInput,
        ID.submitCandidateButton,
        ID.activateLabelInput,
        ID.activateButton,
        ID.rollbackLabelInput,
        ID.rollbackButton,
      ];
      for (const control of controls) {
        const box = await readBox(page, byId(control));
        assertVisible(box, control);
        assertAtMost(box.right, metrics.viewportWidth, `${control} within the page width`);
      }
      const closed = await readGeneration(page);
      await page.click(`${byId(ID.generationDrawer)} summary`);
      assertSame(closed.drawerOpen, true, "the open generation drawer");

      return `the transcript used a ${scroll.height.toFixed(1)}px internal scroll box, page growth was ${metrics.scrollHeight - before.scrollHeight}px, and all ${controls.length} generation controls fit the ${metrics.viewportWidth}px desktop`;
    },
  },
  {
    id: "WID-4",
    title: "resizing across the breakpoint preserves state",
    rank: "should",
    scenario: "ready",
    viewport: { width: 1600, height: 1000 },
    run: async ({ page, server }) => {
      await page.click(projectButton(HARNESS_SELF_PROJECT_ID));
      await waitForThreadOk(page);
      await waitForTranscriptText(page, "HARNESS-THREAD");
      await page.click(`${byId(ID.generationDrawer)} summary`);
      const before = await readConversation(page);
      const beforeRequests = server.requests().length;
      const beforeProjects = await readProjectList(page);

      await page.setViewport(420, 900);
      const narrow = await readLayout(page);
      const narrowConversation = await readConversation(page);
      const narrowProjects = await readProjectList(page);
      assertSame(narrow.drawerOpen, true, "the drawer after narrowing");
      assertSame(
        narrowProjects.selected.join(","),
        HARNESS_SELF_PROJECT_ID,
        "the selected harness at narrow width",
      );
      assertSame(narrowConversation.allText, before.allText, "the conversation at narrow width");
      assert(
        narrow.conversationTop >= narrow.sidebarBottom,
        "the narrow layout stacks the conversation below the sidebar",
      );

      await page.setViewport(1600, 1000);
      const wide = await readLayout(page);
      const after = await readConversation(page);
      const afterProjects = await readProjectList(page);
      const threadGets = selectRequestsLike(server.requests(), "GET", "/thread");
      assertSame(wide.drawerOpen, true, "the drawer after restoring the desktop width");
      assertAtMost(wide.sidebarRight, wide.conversationLeft, "the restored desktop columns");
      assertSame(after.allText, before.allText, "the conversation after resizing back");
      assertSame(
        afterProjects.selected.join(","),
        beforeProjects.selected.join(","),
        "the selected project after resizing back",
      );
      assertSame(server.requests().length, beforeRequests, "requests caused by resizing");

      return `the harness remained selected with ${before.messages} messages and an open drawer across 420px and 1600px; resize added 0 requests (${threadGets.length} thread reads total)`;
    },
  },
];
