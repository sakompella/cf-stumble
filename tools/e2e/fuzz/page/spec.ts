import { always, eventually, extract, now } from "@antithesishq/bombadil";
import { type FuzzWindow, readRows, sendingRows, uiProblems } from "./page-dom.ts";

export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";
export { exploration, waiting } from "./page-actions.ts";

const problems = extract((state) => uiProblems(state.document, readRows(state.document)));

const sending = extract((state) => sendingRows(readRows(state.document)));

const mode = extract((state) => (state.window as FuzzWindow).fzMode ?? "none");

const auditProblems = extract((state) => (state.window as FuzzWindow).fzAudit ?? []);

export const noImpossibleUi = always(() => problems.current.length === 0);

export const pageMatchesServer = always(() => auditProblems.current.length === 0);

export const sendingEnds = always(
  now(() => sending.current > 0 && mode.current === "none").implies(
    eventually(() => sending.current === 0).within(60, "seconds"),
  ),
);
