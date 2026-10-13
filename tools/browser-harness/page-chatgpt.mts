import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * The ChatGPT block in the sidebar as a reader sees it: what the connection says, which controls
 * it offers, and the sign-in link and address box while a sign-in is in progress.
 */

export type ChatGPTSnapshot = Readonly<{
  connection: string;
  result: string;
  hasConnectButton: boolean;
  hasDisconnectButton: boolean;
  hasFinishButton: boolean;
  signInHref: string;
  signInTarget: string;
  signInRel: string;
  instruction: string;
  addressValue: string;
}>;

export function readChatGPT(page: BrowserPage): Promise<ChatGPTSnapshot> {
  return page.evaluate<ChatGPTSnapshot>(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? "";
    const link = document.getElementById("${ID.chatgptSignInLink}");
    const address = document.getElementById("${ID.chatgptCallbackInput}");
    const note = address?.closest(".sidebar-panel")?.querySelector(".note");
    return {
      connection: read("${ID.chatgptConnection}"),
      result: read("${ID.chatgptResult}"),
      hasConnectButton: document.getElementById("${ID.chatgptConnectButton}") !== null,
      hasDisconnectButton: document.getElementById("${ID.chatgptDisconnectButton}") !== null,
      hasFinishButton: document.getElementById("${ID.chatgptFinishButton}") !== null,
      signInHref: link === null ? "" : (link.getAttribute("href") ?? ""),
      signInTarget: link === null ? "" : (link.getAttribute("target") ?? ""),
      signInRel: link === null ? "" : (link.getAttribute("rel") ?? ""),
      instruction: note?.textContent ?? "",
      addressValue: address === null ? "" : address.value,
    };
  })()`);
}
