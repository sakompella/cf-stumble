import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * The values the page renders for the turn, the thread, and the generation ledger.
 *
 * The page writes every result a reader must observe into an element rather than keeping it in a
 * script variable, so these readers read exactly what the owner reads. Each one is a single
 * evaluation, so a snapshot cannot mix two moments of a running turn.
 */

/** The turn's own state, plus just enough of the transcript to prove it is arriving in pieces. */
export type TurnSnapshot = Readonly<{
  turnState: string;
  assistantCharacters: number;
  assistantBlocks: number;
  tools: number;
  finishedTools: number;
  entries: number;
  sendDisabled: boolean;
  cancelDisabled: boolean;
}>;

export function readTurn(page: BrowserPage): Promise<TurnSnapshot> {
  return page.evaluate<TurnSnapshot>(`(() => {
    const assistant = Array.from(document.querySelectorAll("li.${CLASS.message}.assistant pre.text"));
    const summaries = Array.from(document.querySelectorAll("details.${CLASS.toolCall} summary"));
    const send = document.getElementById("${ID.sendTurnButton}");
    const cancel = document.getElementById("${ID.cancelTurnButton}");
    const list = document.getElementById("${ID.messageList}");
    return {
      turnState: document.getElementById("${ID.turnState}")?.textContent ?? "",
      assistantCharacters: assistant.reduce((total, block) =>
        total + (block.textContent ?? "").length, 0),
      assistantBlocks: assistant.length,
      tools: summaries.length,
      finishedTools: summaries.filter((summary) =>
        (summary.textContent ?? "").includes("—")).length,
      entries: list === null ? 0 : list.children.length,
      sendDisabled: send === null ? false : send.disabled,
      cancelDisabled: cancel === null ? true : cancel.disabled,
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
  prompt: string;
}>;

export function readThread(page: BrowserPage): Promise<ThreadSnapshot> {
  return page.evaluate<ThreadSnapshot>(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? "";
    const prompt = document.getElementById("${ID.promptInput}");
    return {
      project: read("${ID.conversationProject}"),
      state: read("${ID.conversationState}"),
      revision: read("${ID.threadRevision}"),
      turnActive: read("${ID.threadTurnActive}"),
      messageCount: read("${ID.threadMessageCount}"),
      freshStatus: read("${ID.freshThreadStatus}"),
      pageError: read("${ID.pageError}"),
      prompt: prompt === null ? "" : prompt.value,
    };
  })()`);
}

/**
 * Everything the generation drawer shows, in one snapshot.
 *
 * The active bar and the three control results are read together because the drawer's claims are
 * relative: a submission that says `ok` while the active bar changed is a different fault from one
 * that says `ok` and left it alone, and two separate reads could not tell them apart.
 */
export type GenerationSnapshot = Readonly<{
  activeLabel: string;
  activeCommit: string;
  activeStatus: string;
  epoch: string;
  lastRead: string;
  drawerOpen: boolean;
  submitStatus: string;
  submitLabel: string;
  submitEpoch: string;
  submitPreparation: string;
  activateStatus: string;
  activateSentEpoch: string;
  activateEffect: string;
  rollbackStatus: string;
  rollbackSentEpoch: string;
  rollbackEffect: string;
  commitInput: string;
  activateLabelInput: string;
  rollbackLabelInput: string;
}>;

export function readGeneration(page: BrowserPage): Promise<GenerationSnapshot> {
  return page.evaluate<GenerationSnapshot>(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? "";
    const field = (id) => {
      const input = document.getElementById(id);
      return input === null ? "" : input.value;
    };
    const drawer = document.getElementById("${ID.generationDrawer}");
    return {
      activeLabel: read("${ID.activeGenerationLabel}"),
      activeCommit: read("${ID.activeGenerationCommit}"),
      activeStatus: read("${ID.activeGenerationStatus}"),
      epoch: read("${ID.generationEpoch}"),
      lastRead: read("${ID.statusStatus}"),
      drawerOpen: drawer === null ? false : drawer.open,
      submitStatus: read("${ID.submitStatus}"),
      submitLabel: read("${ID.submitGenerationLabel}"),
      submitEpoch: read("${ID.submitEpoch}"),
      submitPreparation: read("${ID.submitPreparation}"),
      activateStatus: read("${ID.activateStatus}"),
      activateSentEpoch: read("${ID.activateSentEpoch}"),
      activateEffect: read("${ID.activateEffect}"),
      rollbackStatus: read("${ID.rollbackStatus}"),
      rollbackSentEpoch: read("${ID.rollbackSentEpoch}"),
      rollbackEffect: read("${ID.rollbackEffect}"),
      commitInput: field("${ID.candidateCommitInput}"),
      activateLabelInput: field("${ID.activateLabelInput}"),
      rollbackLabelInput: field("${ID.rollbackLabelInput}"),
    };
  })()`);
}

/** One element's text, for a value that needs no snapshot of its own. */
export function readText(page: BrowserPage, id: string): Promise<string> {
  return page.evaluate<string>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? ""`);
}
