import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { OWNER_PAGE_SCRIPT_GENERATIONS } from "./script-generations.js";
import { OWNER_PAGE_SCRIPT_HELPERS } from "./script-helpers.js";
import { OWNER_PAGE_SCRIPT_STATUS } from "./script-status.js";
import { OWNER_PAGE_SCRIPT_THREAD } from "./script-thread.js";

/**
 * The whole inline script: one immediately invoked function, so the page defines no global. The
 * parts are separate files only to keep each readable; they share one scope here.
 */
export const OWNER_PAGE_SCRIPT = `
"use strict";
(function () {${OWNER_PAGE_SCRIPT_HELPERS}${OWNER_PAGE_SCRIPT_STATUS}${OWNER_PAGE_SCRIPT_THREAD}${OWNER_PAGE_SCRIPT_GENERATIONS}
  function onClick(id, handler) {
    var target = node(id);
    if (target !== null) {
      target.addEventListener("click", function () {
        void handler();
      });
    }
  }

  onClick("${ID.refreshStatusButton}", refreshStatus);
  onClick("${ID.refreshRecoveryButton}", refreshRecovery);
  onClick("${ID.loadThreadButton}", loadThread);
  onClick("${ID.freshThreadButton}", startFreshThread);
  onClick("${ID.submitCandidateButton}", submitCandidate);
  onClick("${ID.activateButton}", function () {
    return runControl("activate");
  });
  onClick("${ID.rollbackButton}", function () {
    return runControl("rollback");
  });

  void refreshStatus();
})();
`;
