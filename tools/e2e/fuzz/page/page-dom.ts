export type Row = Readonly<{ who: string; text: string; buttons: number }>;

export type Sent = Readonly<{ token: string; projectId: string; fault: string; conversation: number }>;

export type FuzzWindow = Window & {
  fzMode?: string;
  fzAudit?: readonly string[];
  fzAuditing?: boolean;
};

const IDS = [
  "owner-page",
  "conversation",
  "conversation-messages",
  "prompt-input",
  "send-turn-button",
  "cancel-turn-button",
  "fresh-thread-button",
  "turn-state",
  "conversation-state",
];

export function readRows(document: Document): readonly Row[] {
  return Array.from(document.querySelectorAll("#conversation-messages > li.message")).map((row) => ({
    who: row.querySelector(".who")?.textContent ?? "",
    text: row.querySelector(".text")?.textContent ?? "",
    buttons: row.querySelectorAll("button").length,
  }));
}

export function selectedProject(document: Document): string {
  const selected = document.querySelector(".project-button.selected");

  return selected?.getAttribute("data-project-id") ?? "";
}

export function textOf(document: Document, id: string): string {
  return document.getElementById(id)?.textContent?.trim() ?? "";
}

export function uiProblems(document: Document, rows: readonly Row[]): readonly string[] {
  const problems: string[] = [];

  for (const id of IDS) {
    const count = document.querySelectorAll(`[id="${id}"]`).length;

    if (count > 1) problems.push(`${count} elements with id ${id}`);
  }

  const composers = document.querySelectorAll("textarea").length;

  if (composers > 1) problems.push(`${composers} composers`);

  for (const row of rows) {
    const unconfirmed = row.who === "you · not confirmed";

    if (unconfirmed && row.buttons !== 1) problems.push(`not-confirmed row has ${row.buttons} buttons`);

    if (!unconfirmed && row.buttons > 0 && row.who.startsWith("you")) {
      problems.push(`row "${row.who}" has a button`);
    }
  }

  const stopped = textOf(document, "page-error");

  if (stopped.startsWith("This page stopped")) problems.push(stopped);

  return problems;
}

export function sendingRows(rows: readonly Row[]): number {
  return rows.filter((row) => row.who === "you · sending").length;
}
