import {
  COMMAND_ID_PREFIX,
  COMMAND_ID_SUFFIXES as SUFFIX,
  OWNER_PAGE_IDS as ID,
} from "./element-ids.js";

/**
 * The chat box: read a saved session, run one turn, and render the reply, the diff, and every
 * executed command with its exit code, stdout, and stderr.
 */
export const OWNER_PAGE_SCRIPT_TURN = `
  function commandField(id, label, value, tag) {
    var row = document.createElement("div");
    var name = document.createElement("span");
    name.className = "field-label";
    name.textContent = label;
    var slot = document.createElement(tag);
    slot.id = id;
    slot.className = "value";
    slot.textContent = value;
    row.appendChild(name);
    row.appendChild(slot);
    return row;
  }

  function commandRow(entry, index) {
    var base = "${COMMAND_ID_PREFIX}" + index;
    var item = document.createElement("li");
    item.id = base;
    item.appendChild(commandField(base + "${SUFFIX.command}", "command", text(entry.command), "code"));
    item.appendChild(commandField(base + "${SUFFIX.exitCode}", "exit code", text(entry.exitCode), "span"));
    item.appendChild(commandField(base + "${SUFFIX.stdout}", "stdout", text(entry.stdout), "pre"));
    item.appendChild(commandField(base + "${SUFFIX.stderr}", "stderr", text(entry.stderr), "pre"));
    return item;
  }

  function renderCommands(commands) {
    var list = node("${ID.commandList}");
    if (list === null) {
      return;
    }
    list.textContent = "";
    var empty = node("${ID.commandsEmpty}");
    if (empty !== null) {
      empty.hidden = commands.length !== 0;
    }
    for (var index = 0; index < commands.length; index += 1) {
      list.appendChild(commandRow(commands[index], index));
    }
  }

  // The turn reports the diff as the output of the git diff it ran, so the last one is the diff.
  function diffOf(commands) {
    for (var index = commands.length - 1; index >= 0; index -= 1) {
      var entry = commands[index];
      if (typeof entry.command === "string" && entry.command.indexOf("git diff") === 0) {
        return entry.stdout;
      }
    }
    return "";
  }

  function renderTurn(result) {
    setRaw("${ID.turnRaw}", result.payload);
    var payload = result.payload;
    if (!payload || payload.ok !== true || !payload.response) {
      setText("${ID.turnStatus}", problemText(payload, result.status));
      return;
    }
    var commands = payload.response.commands ? payload.response.commands : [];
    setText("${ID.turnStatus}", "ok");
    setText("${ID.chatReply}", text(payload.response.text));
    setText("${ID.sessionRevision}", String(payload.response.sessionRevision));
    setText("${ID.sessionTurnActive}", "no");
    renderCommands(commands);
    setText("${ID.turnDiff}", diffOf(commands));
  }

  function currentRevision() {
    var shown = node("${ID.sessionRevision}");
    var parsed = Number.parseInt(shown === null ? "" : shown.textContent, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async function sendTurn() {
    clearError();
    var sessionId = inputValue("${ID.sessionIdInput}");
    if (sessionId === "") {
      setText("${ID.turnStatus}", "enter a session id first");
      return;
    }
    var body = { prompt: inputValue("${ID.chatPromptInput}"), expectedRevision: currentRevision() };
    setText("${ID.turnStatus}", "running");
    try {
      var path = "/api/sessions/" + encodeURIComponent(sessionId) + "/turn";
      renderTurn(await call("POST", path, body));
    } catch (error) {
      setText("${ID.turnStatus}", "request failed");
      reportError("the turn request", error);
    }
  }

  async function loadSession() {
    clearError();
    var sessionId = inputValue("${ID.sessionIdInput}");
    if (sessionId === "") {
      setText("${ID.sessionStatus}", "enter a session id first");
      return;
    }
    setText("${ID.sessionStatus}", "reading");
    try {
      var result = await call("GET", "/api/sessions/" + encodeURIComponent(sessionId));
      var payload = result.payload;
      if (!payload || payload.ok !== true) {
        setText("${ID.sessionStatus}", problemText(payload, result.status));
        return;
      }
      setText("${ID.sessionStatus}", "ok");
      setText("${ID.sessionRevision}", String(payload.session.revision));
      setText("${ID.sessionTurnActive}", payload.session.turnActive ? "yes" : "no");
      setText("${ID.sessionDocument}", text(payload.session.document));
    } catch (error) {
      setText("${ID.sessionStatus}", "request failed");
      reportError("the session request", error);
    }
  }
`;
