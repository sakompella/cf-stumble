import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * What the harness reads out of the page, as typed snapshots.
 *
 * Every identifier and class comes from `src/page/element-ids.ts`, so a renamed identifier breaks
 * this file at compile time instead of turning a check into a silent pass. Each reader takes one
 * snapshot in one round trip, which matters while a turn streams: two separate reads could observe
 * two different moments and let a check claim it saw a state that never existed at once.
 */

export type ConversationSnapshot = Readonly<{
  messages: number;
  roles: readonly string[];
  firstText: string;
  allText: string;
  tools: number;
  toolSummaries: readonly string[];
  openTools: number;
  serverTruncatedNotes: number;
  displayShortenedNotes: number;
}>;

export function readConversation(page: BrowserPage): Promise<ConversationSnapshot> {
  return page.evaluate<ConversationSnapshot>(`(() => {
    const list = document.getElementById("${ID.messageList}");
    const items = Array.from(list === null ? [] : list.children);
    const tools = Array.from(document.querySelectorAll("details.${CLASS.toolCall}"));
    const notes = Array.from(document.querySelectorAll(".${CLASS.toolOutput} .note"));
    return {
      messages: items.length,
      roles: items.map((item) => item.className),
      firstText: items.length === 0 ? "" : (items[0].textContent ?? ""),
      allText: list === null ? "" : (list.textContent ?? ""),
      tools: tools.length,
      toolSummaries: tools.map((tool) => tool.querySelector("summary")?.textContent ?? ""),
      openTools: tools.filter((tool) => tool.open).length,
      serverTruncatedNotes: notes.filter((note) =>
        (note.textContent ?? "").includes("the server truncated")).length,
      displayShortenedNotes: notes.filter((note) =>
        (note.textContent ?? "").includes("shortened for display")).length,
    };
  })()`);
}

/**
 * What the turn said about what it changed, kept apart from what a tool said.
 *
 * A tool result and the turn's own diff (ADR-0040) reach the page by different routes and render
 * into different elements, so they are counted separately here. Counting `.diff-line` across the
 * whole document would let a page that rendered the tool's patch twice, and the turn's diff never,
 * satisfy a check about the turn's diff.
 */
export type DiffSnapshot = Readonly<{
  toolAdded: number;
  toolRemoved: number;
  toolHunks: number;
  diffMessages: number;
  diffAdded: number;
  diffRemoved: number;
  diffHunks: number;
  diffText: string;
  unavailableMessages: number;
  unavailableText: string;
}>;

export function readDiffs(page: BrowserPage): Promise<DiffSnapshot> {
  return page.evaluate<DiffSnapshot>(`(() => {
    const count = (scope, kind) =>
      document.querySelectorAll(scope + " .${CLASS.diffLine}" + kind).length;
    const tool = "pre.${CLASS.toolOutput}";
    const diff = "li.${CLASS.message}.diff:not(.unavailable)";
    const unavailable = document.querySelectorAll("li.${CLASS.message}.diff.unavailable");
    const diffs = document.querySelectorAll(diff);
    return {
      toolAdded: count(tool, ".added"),
      toolRemoved: count(tool, ".removed"),
      toolHunks: count(tool, ".hunk"),
      diffMessages: diffs.length,
      diffAdded: count(diff, ".added"),
      diffRemoved: count(diff, ".removed"),
      diffHunks: count(diff, ".hunk"),
      diffText: Array.from(diffs).map((entry) => entry.textContent ?? "").join(""),
      unavailableMessages: unavailable.length,
      unavailableText: Array.from(unavailable).map((entry) => entry.textContent ?? "").join(""),
    };
  })()`);
}

/** The turn's own state, plus just enough of the transcript to prove it is arriving in pieces. */
export type TurnSnapshot = Readonly<{
  turnState: string;
  assistantCharacters: number;
  tools: number;
  finishedTools: number;
  sendDisabled: boolean;
  cancelDisabled: boolean;
}>;

export function readTurn(page: BrowserPage): Promise<TurnSnapshot> {
  return page.evaluate<TurnSnapshot>(`(() => {
    const assistant = Array.from(document.querySelectorAll("li.${CLASS.message}.assistant pre.text"));
    const summaries = Array.from(document.querySelectorAll("details.${CLASS.toolCall} summary"));
    const send = document.getElementById("${ID.sendTurnButton}");
    const cancel = document.getElementById("${ID.cancelTurnButton}");
    return {
      turnState: document.getElementById("${ID.turnState}")?.textContent ?? "",
      assistantCharacters: assistant.reduce((total, block) =>
        total + (block.textContent ?? "").length, 0),
      tools: summaries.length,
      finishedTools: summaries.filter((summary) =>
        (summary.textContent ?? "").includes("—")).length,
      sendDisabled: send === null ? false : send.disabled,
      cancelDisabled: cancel === null ? true : cancel.disabled,
    };
  })()`);
}

export type ProjectListSnapshot = Readonly<{
  status: string;
  projects: readonly string[];
  labels: readonly string[];
  selected: readonly string[];
  ariaCurrent: readonly string[];
  githubState: string;
  githubDetail: string;
}>;

export function readProjectList(page: BrowserPage): Promise<ProjectListSnapshot> {
  return page.evaluate<ProjectListSnapshot>(`(() => {
    const buttons = Array.from(document.querySelectorAll(".${CLASS.projectButton}"));
    return {
      status: document.getElementById("${ID.projectListStatus}")?.textContent ?? "",
      projects: buttons.map((button) => button.getAttribute("data-project-id") ?? ""),
      labels: buttons.map((button) => button.textContent ?? ""),
      selected: buttons
        .filter((button) => button.classList.contains("${CLASS.selectedProject}"))
        .map((button) => button.getAttribute("data-project-id") ?? ""),
      ariaCurrent: buttons.map((button) => button.getAttribute("aria-current") ?? ""),
      githubState: document.getElementById("${ID.githubState}")?.textContent ?? "",
      githubDetail: document.getElementById("${ID.githubDetail}")?.textContent ?? "",
    };
  })()`);
}

export type ThreadSnapshot = Readonly<{
  project: string;
  state: string;
  revision: string;
  turnActive: string;
  messageCount: string;
  freshStatus: string;
  pageError: string;
}>;

export function readThread(page: BrowserPage): Promise<ThreadSnapshot> {
  return page.evaluate<ThreadSnapshot>(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? "";
    return {
      project: read("${ID.conversationProject}"),
      state: read("${ID.conversationState}"),
      revision: read("${ID.threadRevision}"),
      turnActive: read("${ID.threadTurnActive}"),
      messageCount: read("${ID.threadMessageCount}"),
      freshStatus: read("${ID.freshThreadStatus}"),
      pageError: read("${ID.pageError}"),
    };
  })()`);
}

export type LayoutSnapshot = Readonly<{
  layoutClass: string;
  sidebarWidth: number;
  sidebarRight: number;
  sidebarBottom: number;
  conversationWidth: number;
  conversationLeft: number;
  conversationTop: number;
  viewportWidth: number;
  toggleExpanded: string;
  toggleLabel: string;
  drawerOpen: boolean;
}>;

/**
 * Measured, not assumed: a collapsed sidebar has no box, whatever the class says, and two columns
 * are side by side only when one really ends before the other begins.
 */
export function readLayout(page: BrowserPage): Promise<LayoutSnapshot> {
  return page.evaluate<LayoutSnapshot>(`(() => {
    const sidebar = document.getElementById("${ID.sidebar}");
    const conversation = document.getElementById("${ID.conversation}");
    const toggle = document.getElementById("${ID.sidebarToggle}");
    const drawer = document.getElementById("${ID.generationDrawer}");
    const aside = sidebar === null ? null : sidebar.getBoundingClientRect();
    const main = conversation === null ? null : conversation.getBoundingClientRect();
    return {
      layoutClass: document.getElementById("${ID.layout}")?.className ?? "",
      sidebarWidth: aside === null ? -1 : aside.width,
      sidebarRight: aside === null ? -1 : aside.right,
      sidebarBottom: aside === null ? -1 : aside.bottom,
      conversationWidth: main === null ? -1 : main.width,
      conversationLeft: main === null ? -1 : main.left,
      conversationTop: main === null ? -1 : main.top,
      viewportWidth: document.documentElement.clientWidth,
      toggleExpanded: toggle?.getAttribute("aria-expanded") ?? "",
      toggleLabel: toggle?.textContent ?? "",
      drawerOpen: drawer === null ? false : drawer.open,
    };
  })()`);
}

export type FocusSnapshot = Readonly<{
  id: string;
  tag: string;
  className: string;
  projectId: string;
}>;

export function readFocus(page: BrowserPage): Promise<FocusSnapshot> {
  return page.evaluate<FocusSnapshot>(`(() => {
    const active = document.activeElement;
    return {
      id: active === null ? "" : active.id,
      tag: active === null ? "" : active.tagName.toLowerCase(),
      className: active === null ? "" : active.className,
      projectId: active === null ? "" : (active.getAttribute("data-project-id") ?? ""),
    };
  })()`);
}

/** One element's text, for the drawer values that need no snapshot of their own. */
export function readText(page: BrowserPage, id: string): Promise<string> {
  return page.evaluate<string>(`document.getElementById("${id}")?.textContent ?? ""`);
}
