import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertExcludes,
  assertAtLeast,
  assertIncludes,
  assertNonEmpty,
  assertSame,
  assertRequestBody,
  byId,
  HARNESS_LOCATION,
  HARNESS_PROJECT_ID,
  HARNESS_PROJECT_URL,
  HARNESS_SELF_PROJECT_ID,
  CONNECTED_PROJECT_ID,
  CONNECTED_PROJECT_URL,
  FRAME_INTERVAL_MS,
  projectButton,
  readConversation,
  readBox,
  readLayout,
  readProjectList,
  readThread,
  readTranscript,
  readTurn,
  sleep,
  selectRequests,
  selectRequestsLike,
  sendPrompt,
  waitForText,
  waitForThreadOk,
  type BrowserPage,
  type CaseContext,
  type HarnessCase,
} from "../harness.mjs";

async function inspectGithubStates(
  page: BrowserPage,
  reopen: CaseContext["reopen"],
): Promise<void> {
  await reopen("ready");
  const connected = await readProjectList(page);
  assertSame(connected.githubState, "connected", "connected GitHub state");
  assertSame(connected.githubDetail, "octocat (owner-authorization)", "connected GitHub detail");
  assertSame(connected.verificationHref, "", "connected verification link");
  assertSame(connected.credentialInputs.length, 0, "credential inputs in connected state");
  await reopen("github-awaiting-authorization");
  const awaiting = await readProjectList(page);
  assertSame(awaiting.githubState, "awaiting-authorization", "awaiting GitHub state");
  assertIncludes(awaiting.githubDetail, "WDJB-MJHT", "awaiting GitHub code");
  assertSame(awaiting.verificationHref, "https://github.com/login/device", "device link");
  assertSame(awaiting.verificationText, "https://github.com/login/device", "device link text");
  assertSame(awaiting.verificationTarget, "_blank", "device link target");
  assertIncludes(awaiting.verificationRel, "noreferrer", "device link rel");
  assertIncludes(awaiting.verificationRel, "noopener", "device link rel");
  assertSame(awaiting.credentialInputs.length, 0, "credential inputs while awaiting authorization");
  await reopen("github-disconnected");
  const disconnected = await readProjectList(page);
  assertSame(disconnected.githubState, "disconnected", "disconnected GitHub state");
  assertSame(disconnected.githubDetail, "", "disconnected GitHub detail");
  assertSame(disconnected.verificationHref, "", "disconnected verification link");
  assertSame(disconnected.credentialInputs.length, 0, "credential inputs while disconnected");
}

async function connectRepository(
  page: BrowserPage,
  server: CaseContext["server"],
  reopen: CaseContext["reopen"],
): Promise<void> {
  await reopen("ready");
  server.clearRequests();
  await page.click(byId(ID.connectButton));
  await waitForText(page, ID.connectStatus, "enter a repository url first");
  assertSame(
    selectRequests(server.requests(), "POST", "/api/projects/connect").length,
    0,
    "empty connect requests",
  );
  await page.type(byId(ID.connectRepositoryInput), CONNECTED_PROJECT_URL);
  await page.click(byId(ID.connectButton));
  await waitForText(page, ID.connectStatus, "connected");
  await waitForText(page, ID.projectListStatus, "2 connected");
  const requests = server.requests();
  const connect = selectRequests(requests, "POST", "/api/projects/connect");
  const projectsReads = selectRequests(requests, "GET", "/api/projects");
  const after = await readProjectList(page);
  assertSame(connect.length, 1, "valid connect requests");
  assertRequestBody(connect[0], { repositoryUrl: CONNECTED_PROJECT_URL }, "connect request");
  assertSame(projectsReads.length, 1, "project rereads after connecting");
  assertIncludes(after.projects.join(" "), CONNECTED_PROJECT_ID, "the connected project id");
  assertSame(after.selected[0] ?? "", HARNESS_PROJECT_ID, "selection after connecting");
}

export const CASES: readonly HarnessCase[] = [
  {
    // The status counts connections, and the harness entry is not one: it needs no repository, no
    // credential and no clone. Two buttons, one connection.
    id: "SIDE-1",
    title: "list one repository plus the harness and choose a default",
    rank: "must",
    scenario: "ready",
    run: async ({ page }) => {
      const list = await readProjectList(page);
      const thread = await readThread(page);
      const transcript = (await readTranscript(page)).map((entry) => entry.text).join("\n");
      assertSame(list.projects.length, 2, "the number of project buttons");
      assertIncludes(list.projects.join(" "), HARNESS_PROJECT_ID, "the repository project id");
      assertIncludes(list.projects.join(" "), HARNESS_SELF_PROJECT_ID, "the harness project id");
      assertIncludes(list.locations.join(" "), HARNESS_PROJECT_URL, "the repository location");
      assertIncludes(list.locations.join(" "), HARNESS_LOCATION, "the harness location");
      assertExcludes(list.locations.join(" "), "spoon-knife", "the project locations");
      assertSame(list.status, "1 connected", "the connected-repository count");
      assertSame(list.githubState, "connected", "the GitHub state");
      assertSame(list.githubDetail, "octocat (owner-authorization)", "the GitHub detail");
      assertSame(list.selected.length, 1, "the selected project count");
      assertSame(list.ariaCurrent.filter((value) => value === "true").length, 1, "aria-current");
      assertSame(thread.project, "hello-world", "the default conversation heading");
      assertNonEmpty(transcript, "the default conversation");
      assertIncludes(transcript, HARNESS_PROJECT_ID, "the default conversation project");
      return `two project buttons show ${HARNESS_PROJECT_URL} and ${HARNESS_LOCATION}; the count named 1 connected repository beside the harness checkout, and hello-world is the sole current project with a nonempty thread`;
    },
  },
  {
    id: "SIDE-2",
    title: "selecting harness loads its own thread",
    rank: "must",
    scenario: "ready",
    run: async ({ page, server }) => {
      const before = await readTranscript(page);
      await page.click(projectButton(HARNESS_SELF_PROJECT_ID));
      await waitForThreadOk(page);
      const list = await readProjectList(page);
      const thread = await readThread(page);
      const text = (await readTranscript(page)).map((entry) => entry.text).join("\n");
      const harnessReads = selectRequests(server.requests(), "GET", "/api/projects/harness/thread");
      assertSame(list.selected[0] ?? "", HARNESS_SELF_PROJECT_ID, "the selected project");
      assertSame(list.ariaCurrent.filter((value) => value === "true").length, 1, "aria-current");
      assertSame(thread.project, "harness", "the harness conversation heading");
      assertIncludes(text, HARNESS_SELF_PROJECT_ID, "the harness transcript project");
      assertIncludes(text, HARNESS_LOCATION, "the harness transcript location");
      assertExcludes(text, HARNESS_PROJECT_ID, "the old repository transcript");
      assertAtLeast(harnessReads.length, 1, "the harness thread reads after selection");
      assertSame(
        (await readProjectList(page)).projects.length,
        2,
        "project choices after selection",
      );
      assertNonEmpty(
        before.map((entry) => entry.text).join("\n"),
        "the external transcript before selection",
      );
      return `the harness button loaded ${HARNESS_LOCATION}, left only harness current, and issued ${harnessReads.length} harness thread read(s)`;
    },
  },
  {
    id: "SIDE-3",
    title: "switching projects rejects late frames",
    rank: "should",
    scenario: "project-switch",
    run: async ({ page, server }) => {
      await sendPrompt(page, "Edit the repository");
      await server.waitForBarrier();
      await page.click(projectButton(HARNESS_SELF_PROJECT_ID));
      await waitForThreadOk(page);
      server.release();
      await sleep(FRAME_INTERVAL_MS * 2);
      const list = await readProjectList(page);
      const thread = await readThread(page);
      const conversation = await readConversation(page);
      const turn = await readTurn(page);
      assertSame(list.projects.length, 2, "project choices after switching");
      assertSame(
        list.selected[0] ?? "",
        HARNESS_SELF_PROJECT_ID,
        "the selected project after switching",
      );
      assertIncludes(conversation.allText, "HARNESS-THREAD", "the harness conversation marker");
      assertExcludes(conversation.allText, "EXTERNAL-LATE", "late external turn content");
      assertExcludes(conversation.allText, "octocat-hello-world", "the old project conversation");
      assertSame(thread.project, "harness", "the conversation project after switching");
      assertSame(turn.sendDisabled, false, "Send after switching projects");
      assertSame(turn.cancelDisabled, true, "Cancel after switching projects");
      assertSame(thread.prompt, "", "the harness composer value");
      return `switching at the held frame kept HARNESS-THREAD across 2 projects, excluded EXTERNAL-LATE, and restored an enabled composer for harness`;
    },
  },
  {
    id: "SIDE-4",
    title: "empty project list has an explicit safe state",
    rank: "should",
    scenario: "no-projects",
    run: async ({ page, server }) => {
      const list = await readProjectList(page);
      const thread = await readThread(page);
      assertSame(list.projects.length, 0, "project buttons with no repositories");
      assertSame(list.status, "no repository connected yet", "the empty project status");
      assertSame(list.githubState, "connected", "the empty-catalog GitHub state");
      assertSame(thread.project, "No project selected", "the empty conversation heading");
      assertSame(thread.state, "select a project first", "the empty conversation state");
      assertSame(thread.freshStatus, "", "the initial fresh-thread status");
      await sendPrompt(page, "Do not send this");
      await waitForText(page, ID.turnState, "select a project first");
      await page.click(byId(ID.freshThreadButton));
      await waitForText(page, ID.freshThreadStatus, "select a project first");
      const requests = server.requests();
      const after = await readThread(page);
      assertSame(after.pageError, "", "the empty-project page error");
      assertSame(
        selectRequestsLike(requests, "POST", "/turn").length,
        0,
        "turn requests without a project",
      );
      assertSame(
        selectRequestsLike(requests, "POST", "/thread/fresh").length,
        0,
        "fresh requests without a project",
      );
      assert(
        !requests.some((request) => /null|undefined/u.test(request.path)),
        `request paths had null or undefined: ${requests.map((request) => request.path).join(", ")}`,
      );
      return `an empty catalog rendered a safe no-project state; both actions said select a project first and sent no turn or fresh request`;
    },
  },
  {
    id: "SIDE-5",
    title: "GitHub states and connect action remain safe",
    rank: "should",
    scenario: "ready",
    run: async ({ page, server, reopen }) => {
      await inspectGithubStates(page, reopen);
      await connectRepository(page, server, reopen);
      return `connected, awaiting, and disconnected GitHub states exposed 0 credential inputs; connecting ${CONNECTED_PROJECT_URL} reread projects and preserved ${HARNESS_PROJECT_ID}`;
    },
  },
  {
    id: "SIDE-6",
    title: "collapse and restore keep state and a reachable toggle",
    rank: "should",
    scenario: "ready",
    run: async ({ page }) => {
      const before = await readConversation(page);
      await page.click(byId(ID.sidebarToggle));
      const hidden = await readLayout(page);
      const toggle = await readBox(page, byId(ID.sidebarToggle));
      assertSame(hidden.sidebarWidth, 0, "the collapsed sidebar width");
      assertSame(hidden.toggleExpanded, "false", "collapsed toggle aria-expanded");
      assertSame(hidden.toggleLabel.trim(), "Show projects", "collapsed toggle label");
      assertSame(toggle.visible, true, "the restore toggle visibility");
      await page.click(byId(ID.sidebarToggle));
      const restored = await readLayout(page);
      assert(
        restored.sidebarWidth > 0,
        `the restored sidebar width: read ${restored.sidebarWidth}`,
      );
      assertSame(restored.toggleExpanded, "true", "restored toggle aria-expanded");
      assertSame(restored.toggleLabel.trim(), "Hide", "restored toggle label");
      assertSame(
        (await readConversation(page)).allText,
        before.allText,
        "conversation after collapse and restore",
      );
      return `the sidebar collapsed to width 0 and restored to ${restored.sidebarWidth}px without changing its conversation`;
    },
  },
];
