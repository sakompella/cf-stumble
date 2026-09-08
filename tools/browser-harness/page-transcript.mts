import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * What the harness reads out of the transcript, as typed snapshots.
 *
 * Every identifier and class comes from `src/page/element-ids.ts`, so a renamed identifier breaks
 * this file at compile time instead of turning a case into a silent pass. Each reader takes one
 * snapshot in one round trip, which matters while a turn streams: two separate reads could observe
 * two different moments and let a case claim it saw a state that never existed at once.
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
  createdImages: number;
  createdScripts: number;
  title: string;
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
      createdImages: list === null ? 0 : list.querySelectorAll("img").length,
      createdScripts: list === null ? 0 : list.querySelectorAll("script").length,
      title: document.title,
    };
  })()`);
}

/**
 * The transcript in order, one entry per rendered block.
 *
 * `kind` is the entry's own class list without the shared `message` class, which is how the page
 * distinguishes a user block, an assistant block, a tool block, the turn's diff, the reason a diff
 * was unavailable, and a terminal frame. Order is the assertion CHAT-3 needs: a terminal entry
 * that precedes the diff is a page reporting success before it showed what changed.
 */
export type TranscriptEntry = Readonly<{ kind: string; text: string }>;

export function readTranscript(page: BrowserPage): Promise<readonly TranscriptEntry[]> {
  return page.evaluate<readonly TranscriptEntry[]>(`(() => {
    const list = document.getElementById("${ID.messageList}");
    return Array.from(list === null ? [] : list.children).map((item) => ({
      kind: item.className.split(" ").filter((name) => name !== "${CLASS.message}").join(" "),
      text: item.textContent ?? "",
    }));
  })()`);
}

/** One tool disclosure, as a reader sees it: the summary, whether it is open, and its output. */
export type ToolSnapshot = Readonly<{
  summary: string;
  open: boolean;
  failed: boolean;
  output: string;
  outputLength: number;
  serverTruncated: boolean;
  displayShortened: boolean;
}>;

export function readTools(page: BrowserPage): Promise<readonly ToolSnapshot[]> {
  return page.evaluate<readonly ToolSnapshot[]>(`(() => {
    return Array.from(document.querySelectorAll("details.${CLASS.toolCall}")).map((tool) => {
      const output = tool.querySelector("pre.${CLASS.toolOutput}");
      const text = output === null ? "" : (output.textContent ?? "");
      const notes = Array.from(output === null ? [] : output.querySelectorAll(".note"))
        .map((note) => note.textContent ?? "");
      return {
        summary: tool.querySelector("summary")?.textContent ?? "",
        open: tool.open,
        failed: tool.classList.contains("failed"),
        output: text,
        outputLength: text.length,
        serverTruncated: notes.some((note) => note.includes("the server truncated")),
        displayShortened: notes.some((note) => note.includes("shortened for display")),
      };
    });
  })()`);
}

/**
 * What the turn said about what it changed, kept apart from what a tool said.
 *
 * A tool result and the turn's own diff (ADR-0040) reach the page by different routes and render
 * into different elements, so they are counted separately here. Counting `.diff-line` across the
 * whole document would let a page that rendered the tool's patch twice, and the turn's diff never,
 * satisfy a case about the turn's diff.
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
