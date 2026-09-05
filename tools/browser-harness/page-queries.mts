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
  addedDiffLines: number;
  removedDiffLines: number;
  hunkDiffLines: number;
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
      addedDiffLines: document.querySelectorAll(".${CLASS.diffLine}.added").length,
      removedDiffLines: document.querySelectorAll(".${CLASS.diffLine}.removed").length,
      hunkDiffLines: document.querySelectorAll(".${CLASS.diffLine}.hunk").length,
      serverTruncatedNotes: notes.filter((note) =>
        (note.textContent ?? "").includes("the server truncated")).length,
      displayShortenedNotes: notes.filter((note) =>
        (note.textContent ?? "").includes("shortened for display")).length,
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
  conversationWidth: number;
  toggleExpanded: string;
  toggleLabel: string;
  drawerOpen: boolean;
}>;

/** Measured, not assumed: a collapsed sidebar has no box, whatever the class says. */
export function readLayout(page: BrowserPage): Promise<LayoutSnapshot> {
  return page.evaluate<LayoutSnapshot>(`(() => {
    const sidebar = document.getElementById("${ID.sidebar}");
    const conversation = document.getElementById("${ID.conversation}");
    const toggle = document.getElementById("${ID.sidebarToggle}");
    const drawer = document.getElementById("${ID.generationDrawer}");
    return {
      layoutClass: document.getElementById("${ID.layout}")?.className ?? "",
      sidebarWidth: sidebar === null ? -1 : sidebar.getBoundingClientRect().width,
      conversationWidth: conversation === null ? -1 : conversation.getBoundingClientRect().width,
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
