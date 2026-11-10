import { readRows, selectedProject, sendingRows, textOf, type Row, type Sent } from "./page-dom.ts";
import { serverState, type Server } from "./page-server.ts";
import { fz } from "./page-state.ts";
import { markAudited, postLog, sentTokens, wasCancelled } from "./page-store.ts";

const AUDIT_WINDOW_MS = 45_000;

const RETRY_MS = 1_500;

const CHANGED = "page changed while reading";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function storedCount(server: Server, token: string): number {
  return server.users.filter((text) => text.includes(token)).length;
}

function sendProblems(
  server: Server,
  rows: readonly Row[],
  sent: readonly Sent[],
  window: Window,
  projectId: string,
): string[] {
  const problems: string[] = [];

  for (const { token, projectId: sentTo } of sent) {
    const stored = storedCount(server, token);

    if (sentTo !== projectId && rows.some((row) => row.text.includes(token))) {
      problems.push(`${token} shown in another project`);
    }

    if (sentTo === projectId && stored > 1) {
      const posts = postLog(window).filter((body) => body.includes(token));

      problems.push(`duplicate turn: ${token} stored ${stored} times, posted ${posts.length}`);
    }
  }

  return problems;
}

function lostSends(
  server: Server,
  sent: readonly Sent[],
  projectId: string,
  window: Window,
): string[] {
  return sent.flatMap((entry) =>
    entry.projectId === projectId &&
    entry.fault === "none" &&
    !wasCancelled(window, entry.token) &&
    entry.conversation === server.conversation &&
    storedCount(server, entry.token) === 0
      ? [`send lost: ${entry.token}`]
      : [],
  );
}

function transcriptProblems(server: Server, rows: readonly Row[], document: Document): string[] {
  const problems: string[] = [];
  const shown = rows.flatMap((row) => (row.who === "you" ? [row.text] : []));
  const compared = Math.min(shown.length, server.users.length);
  const hasMore = document.querySelectorAll("#conversation-messages > li.load").length > 0;
  const answers = rows.filter((row) => row.who === "assistant").length;

  if (
    compared > 0 &&
    shown.slice(-compared).join("\u0001") !== server.users.slice(-compared).join("\u0001")
  ) {
    problems.push(`transcript users differ: page ${shown.length} stored ${server.users.length}`);
  }

  if (server.isFull && !hasMore && shown.length !== server.users.length) {
    problems.push(`user rows ${shown.length} but ${server.users.length} stored`);
  }

  if (server.isFull && !hasMore && answers !== server.assistants) {
    problems.push(`assistant rows ${answers} but ${server.assistants} stored`);
  }

  return problems;
}

function settledProblems(server: Server, rows: readonly Row[], document: Document): string[] {
  const problems: string[] = [];

  if (textOf(document, "thread-run-active") === "yes") {
    problems.push("page runs a turn the server settled");
  }

  if (textOf(document, "thread-queued") !== "0") {
    problems.push("page queue not empty, server inbox empty");
  }

  if (sendingRows(rows) > 0) problems.push("a message is still sending after the server settled");

  if (rows.some((row) => row.who === "you · queued")) {
    problems.push("a message is still queued after the server settled");
  }

  for (const row of rows.filter((entry) => entry.who === "you · not confirmed")) {
    if (server.users.includes(row.text)) problems.push("Retry shown for a stored message");
  }

  return problems;
}

function mismatches(
  server: Server,
  rows: readonly Row[],
  sent: readonly Sent[],
  document: Document,
  window: Window,
): string[] {
  const projectId = selectedProject(document);
  const problems = sendProblems(server, rows, sent, window, projectId);

  if (!server.isIdle) return problems;

  return [
    ...problems,
    ...lostSends(server, sent, projectId, window),
    ...transcriptProblems(server, rows, document),
    ...settledProblems(server, rows, document),
  ];
}

async function auditOnce(document: Document, window: Window, projectId: string): Promise<string[]> {
  const before = JSON.stringify(readRows(document));

  try {
    const server = await serverState(window, projectId);
    const rows = readRows(document);

    return before === JSON.stringify(rows)
      ? mismatches(server, rows, sentTokens(window), document, window)
      : [CHANGED];
  } catch (cause) {
    return [`audit could not read the server: ${String(cause)}`];
  }
}

async function auditLoop(document: Document, window: Window, projectId: string): Promise<void> {
  const deadline = Date.now() + AUDIT_WINDOW_MS;
  let problems: string[] = [];

  do {
    problems = await auditOnce(document, window, projectId);

    if (problems.length > 0) await delay(RETRY_MS);
  } while (problems.length > 0 && Date.now() < deadline);

  fz.audit = problems.includes(CHANGED) ? [] : problems;
  fz.auditing = false;
  markAudited(window);
}

export function startAudit(document: Document, window: Window): void {
  const projectId = selectedProject(document);

  fz.mode = "none";
  fz.audit = [];

  if (projectId === "") return;

  fz.auditing = true;
  auditLoop(document, window, projectId).catch(() => {
    fz.auditing = false;
  });
}
