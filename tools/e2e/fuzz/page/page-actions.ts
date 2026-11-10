import { actions, extract, getFingerprint, weighted, type ActionTemplate } from "@antithesishq/bombadil/browser";
import { back, forward, reload, scroll } from "@antithesishq/bombadil/browser/defaults/actions";
import config from "./config.json";
import { audit, sendTurn, setMode, typeDraft } from "./page-handlers.ts";
import { draftText, hostileText, newToken, pick, sendMode } from "./hostile.ts";
import { selectedProject, type FuzzWindow } from "./page-dom.ts";
import { sentTokens } from "./page-audit.ts";

const CLICKABLE = [
  "#cancel-turn-button",
  "#project-sidebar-toggle",
  ".project-button",
  "#prompt-input",
  "#conversation-messages button",
  "#refresh-status-button",
  "#github-refresh-button",
].join(",");

type Target = Readonly<{ fingerprint: ReturnType<typeof getFingerprint>; point: { x: number; y: number } }>;

const targets = extract((state) =>
  Array.from(state.document.querySelectorAll<HTMLElement>(CLICKABLE)).flatMap((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const inside = x >= 0 && y >= 0 && x < state.window.innerWidth && y < state.window.innerHeight;
    const hit = state.document.elementFromPoint(x, y);

    return inside && hit !== null && element.contains(hit) && box.width > 0
      ? [{ fingerprint: getFingerprint(element), point: { x, y } }]
      : [];
  }),
);

const fresh = extract((state) => {
  const element = state.document.querySelector<HTMLButtonElement>("#fresh-thread-button");

  if (element === null || element.disabled) return null;

  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hit = state.document.elementFromPoint(x, y);

  return hit !== null && element.contains(hit) && x < state.window.innerWidth && y < state.window.innerHeight
    ? { fingerprint: getFingerprint(element), point: { x, y } }
    : null;
});

const sendsLeft = extract((state) =>
  config.maxSends - Number(state.window.sessionStorage.getItem("fz.sends") ?? "0"),
);

const pendingAudit = extract(
  (state) => sentTokens(state.window).length > Number(state.window.sessionStorage.getItem("fz.audited") ?? "0"),
);

const justReloaded = extract((state) => state.lastAction === "Reload");

const auditing = extract((state) => (state.window as FuzzWindow).fzAuditing === true);

const projects = extract((state) => selectedProject(state.document));

const clicks = actions(() => targets.current.map((target: Target): ActionTemplate => ({ Click: target })));

const freshThread = actions(() =>
  fresh.current === null ? [] : [{ DoubleClick: fresh.current }],
);

const drafts = actions(() => [typeDraft(draftText())]);

const turns = actions(() => {
  if (sendsLeft.current <= 0 || projects.current === "") return [];

  const token = newToken();

  return [sendTurn(token, hostileText(token), sendMode())];
});

const faults = actions(() => [setMode(pick(["offline", "drop", "slow", "none", "none"]))]);

const audits = actions(() => [audit()]);

const viewports = actions(() => [
  pick([
    { SetViewport: { width: 375, height: 700 } },
    { SetViewport: { width: 700, height: 800 } },
    { SetViewport: { width: 1280, height: 900 } },
  ]),
]);

const navigation = weighted([
  [3, reload],
  [2, back],
  [1, forward],
]);

const auditsWhenDue = audits.when(() => justReloaded.current || pendingAudit.current);

export const exploration = weighted([
  [30, clicks],
  [8, freshThread],
  [10, turns],
  [6, drafts],
  [6, faults],
  [3, audits],
  [60, auditsWhenDue],
  [8, navigation],
  [3, viewports],
  [5, scroll],
]).when(() => !auditing.current);

export const waiting = actions(() => ["Wait"]).when(() => auditing.current);
