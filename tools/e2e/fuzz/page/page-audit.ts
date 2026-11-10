import { readRows, selectedProject, sendingRows, textOf, type FuzzWindow, type Row, type Sent } from "./page-dom.ts";

type Item = Readonly<{ id: number; kind: string; conversationId: number; model: readonly Record<string, unknown>[] }>;

type Server = Readonly<{
  conversation: number;
  users: readonly string[];
  assistants: number;
  isFull: boolean;
  isIdle: boolean;
}>;

const TOKENS_KEY = "fz.tokens";

const AUDIT_WINDOW_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function sentTokens(window: Window): readonly Sent[] {
  return JSON.parse(window.sessionStorage.getItem(TOKENS_KEY) ?? "[]") as Sent[];
}

export function recordSent(window: Window, sent: Sent): void {
  window.sessionStorage.setItem(TOKENS_KEY, JSON.stringify([...sentTokens(window), sent]));
}

function textOfMessage(message: Record<string, unknown>): string {
  const { content } = message;

  if (typeof content === "string") return content;

  return Array.isArray(content)
    ? content.map((block: { text?: string }) => block.text ?? "").join("")
    : "";
}

async function firstLine(response: Response): Promise<string> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";

  while (reader !== undefined && !text.includes("\n")) {
    const { done, value } = await reader.read();

    if (done) break;

    text += value;
  }

  await reader?.cancel();

  return text.slice(0, text.indexOf("\n"));
}

type Frame = Readonly<{
  conversation: number;
  docs: Record<string, { run?: unknown; items?: unknown[] }>;
}>;

async function readFrame(window: Window, projectId: string): Promise<Frame> {
  const response = await window.fetch(`/api/projects/${encodeURIComponent(projectId)}/events`);
  const frame = JSON.parse(await firstLine(response)) as [
    ["r", { conversation: { id: number }; docs: Frame["docs"] }],
  ];

  return { conversation: frame[0][1].conversation.id, docs: frame[0][1].docs };
}

export async function conversationOf(window: Window, projectId: string): Promise<number> {
  return (await readFrame(window, projectId)).conversation;
}

async function serverState(window: FuzzWindow, projectId: string): Promise<Server> {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const entries = (await (await window.fetch(`${base}/entries?limit=100`)).json()) as { items: Item[] };
  const { docs, conversation } = await readFrame(window, projectId);
  const current = entries.items.filter((item) => item.conversationId === conversation).toReversed();
  const messages = current.flatMap((item) => item.model.map((message) => ({ item, message })));

  return {
    conversation,
    users: messages.filter(({ message }) => message["role"] === "user").map(({ message }) => textOfMessage(message)),
    assistants: messages.filter(
      ({ message }) => message["role"] === "assistant" && textOfMessage(message).trim() !== "",
    ).length,
    isFull: entries.items.length < 100,
    isIdle: docs["pi.live"]?.run === undefined && (docs["pi.inbox"]?.items ?? []).length === 0,
  };
}

function confirmedTexts(rows: readonly Row[]): readonly string[] {
  return rows.filter((row) => row.who === "you").map((row) => row.text);
}

function mismatches(server: Server, rows: readonly Row[], sent: readonly Sent[], document: Document) {
  const problems: string[] = [];
  const here = sent.filter((entry) => entry.projectId === selectedProject(document));
  const shown = confirmedTexts(rows);

  for (const { token } of here) {
    const stored = server.users.filter((text) => text.includes(token)).length;

    if (stored > 1) problems.push(`duplicate turn: ${token} stored ${stored} times`);
  }

  for (const { token } of sent.filter((entry) => entry.projectId !== selectedProject(document))) {
    if (rows.some((row) => row.text.includes(token))) problems.push(`${token} shown in another project`);
  }

  if (!server.isIdle) return problems;

  for (const { token, fault, conversation } of here) {
    const stored = server.users.filter((text) => text.includes(token)).length;

    if (fault === "none" && conversation === server.conversation && stored === 0) problems.push(`send lost: ${token}`);
  }

  const compared = Math.min(shown.length, server.users.length);

  if (shown.slice(-compared).join("\u0001") !== server.users.slice(-compared).join("\u0001") && compared > 0) {
    problems.push(`transcript users differ: page ${shown.length} stored ${server.users.length}`);
  }

  const hasMore = document.querySelectorAll("#conversation-messages > li.load").length > 0;

  if (server.isFull && !hasMore && shown.length !== server.users.length) {
    problems.push(`user rows ${shown.length} but ${server.users.length} stored`);
  }

  const answers = rows.filter((row) => row.who === "assistant").length;

  if (server.isFull && !hasMore && answers !== server.assistants) {
    problems.push(`assistant rows ${answers} but ${server.assistants} stored`);
  }

  if (textOf(document, "thread-run-active") === "yes") problems.push("page runs a turn the server settled");

  if (textOf(document, "thread-queued") !== "0") problems.push("page queue not empty, server inbox empty");

  if (sendingRows(rows) > 0) problems.push("a message is still sending after the server settled");

  if (rows.some((row) => row.who === "you · queued")) problems.push("a message is still queued after the server settled");

  for (const row of rows.filter((entry) => entry.who === "you · not confirmed")) {
    if (server.users.includes(row.text)) problems.push("Retry shown for a stored message");
  }

  return problems;
}

function signature(rows: readonly Row[]): string {
  return JSON.stringify(rows);
}

async function auditLoop(document: Document, window: FuzzWindow, projectId: string): Promise<void> {
  const deadline = Date.now() + AUDIT_WINDOW_MS;
  let problems: readonly string[] = [];

  while (Date.now() < deadline) {
    const before = readRows(document);

    try {
      const server = await serverState(window, projectId);
      const rows = readRows(document);

      problems = signature(before) === signature(rows) ? mismatches(server, rows, sentTokens(window), document) : ["page changed while reading"];
    } catch (cause) {
      problems = [`audit could not read the server: ${String(cause)}`];
    }

    if (problems.length === 0) break;

    await sleep(1_500);
  }

  window.fzAudit = problems.includes("page changed while reading") ? [] : problems;
  window.fzAuditing = false;
  window.sessionStorage.setItem("fz.audited", String(sentTokens(window).length));
}

export function startAudit(document: Document, window: FuzzWindow): void {
  const projectId = selectedProject(document);

  window.fzMode = "none";
  window.fzAudit = [];

  if (projectId === "") return;

  window.fzAuditing = true;
  auditLoop(document, window, projectId).catch(() => {
    window.fzAuditing = false;
  });
}
