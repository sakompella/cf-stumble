import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * The project thread panel: read the selected project's current Pi thread, and start a fresh one.
 *
 * The page sends a project id and nothing else. The Supervisor resolves that id against the
 * catalog and names the thread itself, so the worst a wrong value here can do is name a project
 * the tenant does not have.
 */
export const OWNER_PAGE_SCRIPT_THREAD = `
  function renderThread(result) {
    setRaw("${ID.threadRaw}", result.payload);
    var payload = result.payload;
    if (!payload || payload.ok !== true || !payload.thread) {
      setText("${ID.threadStatus}", problemText(payload, result.status));
      return;
    }
    var thread = payload.thread;
    setText("${ID.threadStatus}", "ok");
    setText("${ID.threadProject}", text(thread.projectId));
    setText("${ID.threadRevision}", String(thread.revision));
    setText("${ID.threadTurnActive}", thread.turnActive ? "yes" : "no");
    setText("${ID.threadMessageCount}", String(thread.messageCount));
  }

  function threadPath(projectId, suffix) {
    return "/api/projects/" + encodeURIComponent(projectId) + "/thread" + suffix;
  }

  async function requestThread(method, suffix, pending) {
    clearError();
    var projectId = inputValue("${ID.projectIdInput}");
    if (projectId === "") {
      setText("${ID.threadStatus}", "enter a project id first");
      return;
    }
    setText("${ID.threadStatus}", pending);
    try {
      renderThread(await call(method, threadPath(projectId, suffix), undefined));
    } catch (error) {
      setText("${ID.threadStatus}", "request failed");
      reportError("the thread request", error);
    }
  }

  function loadThread() {
    return requestThread("GET", "", "reading");
  }

  function startFreshThread() {
    return requestThread("POST", "/fresh", "starting a fresh thread");
  }
`;
