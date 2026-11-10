import type { Sent } from "./page-dom.ts";

const TOKENS_KEY = "fz.tokens";

const POSTS_KEY = "fz.posts";

const AUDITED_KEY = "fz.audited";

const SENDS_KEY = "fz.sends";

function lines(window: Window, key: string): string[] {
  return (window.sessionStorage.getItem(key) ?? "").split("\n").filter((line) => line !== "");
}

function append(window: Window, key: string, line: string): void {
  window.sessionStorage.setItem(key, [...lines(window, key), line].join("\n"));
}

function number(window: Window, key: string): number {
  return Number(window.sessionStorage.getItem(key) ?? "0");
}

export function sentTokens(window: Window): readonly Sent[] {
  return lines(window, TOKENS_KEY).map((line) => {
    const [token = "", projectId = "", fault = "", conversation = "-1"] = line.split("\t");

    return { token, projectId, fault, conversation: Number(conversation) };
  });
}

export function recordSent(window: Window, sent: Sent): void {
  append(
    window,
    TOKENS_KEY,
    [sent.token, sent.projectId, sent.fault, String(sent.conversation)].join("\t"),
  );
}

export function postLog(window: Window): readonly string[] {
  return lines(window, POSTS_KEY);
}

export function recordPost(window: Window, body: string): void {
  append(window, POSTS_KEY, body.replaceAll("\n", " ").slice(0, 400));
}

export function auditedCount(window: Window): number {
  return number(window, AUDITED_KEY);
}

export function markAudited(window: Window): void {
  window.sessionStorage.setItem(AUDITED_KEY, String(sentTokens(window).length));
}

export function sendsMade(window: Window): number {
  return number(window, SENDS_KEY);
}

export function countSend(window: Window): void {
  window.sessionStorage.setItem(SENDS_KEY, String(sendsMade(window) + 1));
}
