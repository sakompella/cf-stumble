import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * The selected project's saved conversation, and the fresh thread that replaces it.
 *
 * A thread read renders the whole saved conversation, so a second browser that loads this page — or
 * the same browser after a reload — sees what the Supervisor committed rather than what one client
 * happened to receive while a turn ran (ADR-0037, ADR-0038). The stored messages are Pi's, so this
 * reader takes only what it understands: the text blocks of a message and a tool result's name and
 * output. Anything else is shown as its role and nothing more, because a page that guessed at Pi's
 * schema would break on the next Pi version.
 *
 * A fresh thread needs two clicks. The first arms it and says what it does; the second sends it.
 * That is the explicit action goal criterion 5 asks for, and it is why a reader cannot lose a
 * conversation by pressing the wrong button once.
 */
export const OWNER_PAGE_SCRIPT_CONVERSATION = `
  function contentText(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    var parts = [];
    for (var index = 0; index < content.length; index += 1) {
      var block = content[index];
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }

  function renderSavedMessage(message) {
    if (!message || typeof message.role !== "string") {
      return;
    }
    if (message.role === "toolResult") {
      toolResult({
        toolCallId: text(message.toolCallId),
        toolName: text(message.toolName),
        content: contentText(message.content),
        isError: message.isError === true,
        truncated: false,
      });
      return;
    }
    var body = contentText(message.content);
    if (message.role === "user") {
      textMessage("user", "you", body);
      return;
    }
    if (message.role === "assistant") {
      textMessage("assistant", "assistant", body);
      return;
    }
    textMessage("system", message.role, body);
  }

  function renderSavedConversation(conversation) {
    clearConversation();
    var messages = null;
    try {
      messages = JSON.parse(typeof conversation === "string" ? conversation : "[]");
    } catch (error) {
      messages = null;
    }
    if (!Array.isArray(messages)) {
      setText("${ID.conversationState}", "the saved conversation could not be read");
      return;
    }
    for (var index = 0; index < messages.length; index += 1) {
      renderSavedMessage(messages[index]);
    }
  }

  function renderThread(result, replaceConversation) {
    var payload = result.payload;
    if (!payload || payload.ok !== true || !payload.thread) {
      setText("${ID.conversationState}", problemText(payload, result.status));
      return false;
    }
    var thread = payload.thread;
    setText("${ID.conversationState}", "ok");
    setText("${ID.threadRevision}", String(thread.revision));
    setText("${ID.threadTurnActive}", thread.turnActive ? "yes" : "no");
    setText("${ID.threadMessageCount}", String(thread.messageCount));
    if (replaceConversation) {
      renderSavedConversation(thread.conversation);
    }
    return true;
  }

  // A stale answer belongs to the project the reader left, so it is dropped rather than rendered.
  async function loadThread(quiet) {
    var projectId = page.projectId;
    if (projectId === null) {
      setText("${ID.conversationState}", "select a project first");
      return;
    }
    var token = page.selection;
    if (!quiet) {
      setText("${ID.conversationState}", "reading");
    }
    try {
      var result = await call("GET", projectPath(projectId, "/thread"), undefined);
      if (token !== page.selection) {
        return;
      }
      renderThread(result, !quiet);
    } catch (error) {
      if (token === page.selection) {
        setText("${ID.conversationState}", "disconnected from this Worker");
        reportError("the thread request", error);
      }
    }
  }

  async function replaceThread() {
    var projectId = page.projectId;
    var token = page.selection;
    setText("${ID.freshThreadStatus}", "starting a fresh thread");
    try {
      var result = await call("POST", projectPath(projectId, "/thread/fresh"), undefined);
      if (token !== page.selection) {
        return;
      }
      var ok = renderThread(result, true);
      setText(
        "${ID.freshThreadStatus}",
        ok ? "fresh thread started; repository files are untouched" : "not started",
      );
      setText("${ID.turnState}", "");
    } catch (error) {
      setText("${ID.freshThreadStatus}", "request failed");
      reportError("the fresh thread request", error);
    }
  }

  function startFreshThread() {
    clearError();
    if (page.projectId === null) {
      setText("${ID.freshThreadStatus}", "select a project first");
      return;
    }
    if (page.turnActive) {
      setText("${ID.freshThreadStatus}", "a turn is running; cancel it first");
      return;
    }
    if (!page.freshArmed) {
      page.freshArmed = true;
      setText(
        "${ID.freshThreadStatus}",
        "click again to replace this conversation; repository files are untouched",
      );
      return;
    }
    page.freshArmed = false;
    return replaceThread();
  }
`;
