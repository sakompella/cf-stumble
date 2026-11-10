import { registerCustomAction } from "@antithesishq/bombadil/browser";
import config from "./config.json";
import { conversationOf, startAudit, recordSent } from "./page-audit.ts";
import { selectedProject, type FuzzWindow } from "./page-dom.ts";
import { installNet } from "./page-net.ts";

const SENDS_KEY = "fz.sends";

function typeInto(document: Document, text: string): HTMLTextAreaElement | undefined {
  const field = document.querySelector<HTMLTextAreaElement>("#prompt-input");

  if (field === null) return undefined;

  field.focus();
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));

  return field;
}

export const typeDraft = registerCustomAction("typeDraft", async (document, _window, text: string) => {
  typeInto(document, text);
});

export const setMode = registerCustomAction("setMode", async (_document, window, mode: string) => {
  const fuzz = window as FuzzWindow;

  installNet(fuzz);
  fuzz.fzMode = mode;
});

export const audit = registerCustomAction("audit", async (document, window) => {
  startAudit(document, window as FuzzWindow);
});

export const sendTurn = registerCustomAction(
  "sendTurn",
  async (document, window, token: string, text: string, how: string) => {
    const sends = Number(window.sessionStorage.getItem(SENDS_KEY) ?? "0");
    const field = document.querySelector<HTMLTextAreaElement>("#prompt-input");
    const button = document.querySelector<HTMLButtonElement>("#send-turn-button");

    if (sends >= config.maxSends || field === null || button === null) return;

    const projectId = selectedProject(document);
    const conversation = await conversationOf(window, projectId).catch(() => -1);

    window.sessionStorage.setItem(SENDS_KEY, String(sends + 1));
    recordSent(window, { token, projectId, fault: (window as FuzzWindow).fzMode ?? "none", conversation });
    typeInto(document, text);

    if (how === "shortcut") {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    } else {
      button.click();

      if (how === "double") button.click();
    }
  },
);
