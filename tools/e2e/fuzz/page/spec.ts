import { always, eventually, now } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";
import { readRows, sendingRows, uiProblems } from "./page-dom.ts";
import { fz } from "./page-state.ts";

export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

export { exploration, waiting } from "./page-actions.ts";

const problems = extract((state) => uiProblems(state.document, readRows(state.document)));

const sending = extract((state) => sendingRows(readRows(state.document)));

const mode = extract(() => fz.mode);

const auditProblems = extract(() => fz.audit);

export const noImpossibleUi = always(() => (problems.current ?? []).length === 0);

export const pageMatchesServer = always(() => (auditProblems.current ?? []).length === 0);

export const sendingEnds = always(
  now(() => sending.current > 0 && mode.current === "none").implies(
    eventually(() => sending.current === 0).within(60, "seconds"),
  ),
);
