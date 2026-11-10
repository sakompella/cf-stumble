import { registerCustomAction } from "@antithesishq/bombadil/browser";
import config from "./config.json";
import { startAudit } from "./page-audit.ts";
import { selectedProject } from "./page-dom.ts";
import { installNet } from "./page-net.ts";
import { conversationOf } from "./page-server.ts";
import { fz } from "./page-state.ts";
import { countSend, recordSent, sendsMade } from "./page-store.ts";

function typeInto(document: Document, text: string): HTMLTextAreaElement | undefined {
  const field = document.querySelector<HTMLTextAreaElement>("#prompt-input");

  if (field === null) return undefined;

  field.focus();
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));

  return field;
}

export const typeDraft = registerCustomAction("typeDraft", (document, _window, text: string) => {
  typeInto(document, text);

  return Promise.resolve();
});

export const setMode = registerCustomAction("setMode", (_document, window, mode: string) => {
  installNet(window);
  fz.mode = mode;

  return Promise.resolve();
});

export const audit = registerCustomAction("audit", (document, window) => {
  startAudit(document, window);

  return Promise.resolve();
});

export const sendTurn = registerCustomAction(
  "sendTurn",
  async (document, window, token: string, text: string, how: string) => {
    const field = document.querySelector<HTMLTextAreaElement>("#prompt-input");
    const button = document.querySelector<HTMLButtonElement>("#send-turn-button");

    if (sendsMade(window) >= config.maxSends || field === null || button === null) return;

    const projectId = selectedProject(document);
    const conversation = await conversationOf(window, projectId).catch(() => -1);

    countSend(window);
    recordSent(window, {
      token,
      projectId,
      fault: fz.mode,
      conversation,
    });
    typeInto(document, text);

    if (how === "shortcut") {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      button.click();

      if (how === "double") button.click();
    }
  },
);
