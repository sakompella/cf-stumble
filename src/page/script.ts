import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { OWNER_PAGE_SCRIPT_CONVERSATION } from "./script-conversation.js";
import { OWNER_PAGE_SCRIPT_GENERATIONS } from "./script-generations.js";
import { OWNER_PAGE_SCRIPT_HELPERS } from "./script-helpers.js";
import { OWNER_PAGE_SCRIPT_PROJECTS } from "./script-projects.js";
import { OWNER_PAGE_SCRIPT_RENDER } from "./script-render.js";
import { OWNER_PAGE_SCRIPT_STATUS } from "./script-status.js";
import { OWNER_PAGE_SCRIPT_TURN } from "./script-turn.js";

/**
 * The whole inline script: one immediately invoked function, so the page defines no global. The
 * parts are separate files only to keep each readable; they share one scope here, and function
 * declarations hoist, so the order below is about reading rather than about dependencies.
 *
 * Every handler is attached with `addEventListener`. The page carries no inline event attribute, so
 * the Content Security Policy the route sends admits this one nonced script and nothing else.
 */
const OWNER_PAGE_SCRIPT_WIRING = `
  function onClick(id, handler) {
    var target = node(id);
    if (target !== null) {
      target.addEventListener("click", function () {
        void handler();
      });
    }
  }

  onClick("${ID.sidebarToggle}", toggleSidebar);
  onClick("${ID.connectButton}", connectProject);
  onClick("${ID.authorizeButton}", function () {
    return authorizeGitHub("/api/github/authorization");
  });
  onClick("${ID.completeAuthorizationButton}", function () {
    return authorizeGitHub("/api/github/authorization/complete");
  });
  onClick("${ID.sendTurnButton}", sendTurn);
  onClick("${ID.cancelTurnButton}", cancelTurn);
  onClick("${ID.freshThreadButton}", startFreshThread);
  onClick("${ID.refreshStatusButton}", refreshStatus);
  onClick("${ID.refreshRecoveryButton}", refreshRecovery);
  onClick("${ID.submitCandidateButton}", submitCandidate);
  onClick("${ID.activateButton}", function () {
    return runControl("activate");
  });
  onClick("${ID.rollbackButton}", function () {
    return runControl("rollback");
  });

  // Control-Enter sends, so a keyboard reader never has to leave the prompt to run a turn.
  var prompt = node("${ID.promptInput}");
  if (prompt !== null) {
    prompt.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void sendTurn();
      }
    });
  }

  clearConversation();
  void refreshStatus();
  void loadProjects();
`;

export const OWNER_PAGE_SCRIPT = `
"use strict";
(function () {${OWNER_PAGE_SCRIPT_HELPERS}${OWNER_PAGE_SCRIPT_RENDER}${OWNER_PAGE_SCRIPT_PROJECTS}${OWNER_PAGE_SCRIPT_CONVERSATION}${OWNER_PAGE_SCRIPT_TURN}${OWNER_PAGE_SCRIPT_STATUS}${OWNER_PAGE_SCRIPT_GENERATIONS}${OWNER_PAGE_SCRIPT_WIRING}})();
`;
