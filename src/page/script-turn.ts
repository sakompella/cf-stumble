import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * The streaming turn: `POST /api/projects/{id}/turn` and the newline-delimited frames it answers
 * with (`routes/turns.ts`, `supervisor/projects/turn-frames.ts`).
 *
 * The response body is read as it arrives, so text, tool calls, bounded tool output, and a diff
 * appear while the turn runs rather than in one block at the end (ADR-0037). Exactly one terminal
 * frame ends a stream and it is the Supervisor's own statement about what was durably saved, so
 * this page never reports success from an HTTP status: `saved` is the only success wording, and
 * `save-failed`, `turn-failed`, `stream-invalid`, `cancelled`, and `timed-out` each say what
 * happened instead.
 *
 * Cancelling aborts the fetch, which cancels the response body, which is how the Supervisor learns
 * the browser is gone. A project switch aborts it the same way, and the selection token means a
 * frame that was already in flight cannot be appended to another project's conversation.
 */
export const OWNER_PAGE_SCRIPT_TURN = `
  var TERMINAL_KINDS = [
    "saved",
    "turn-failed",
    "turn-rejected",
    "save-failed",
    "stream-invalid",
    "cancelled",
    "timed-out",
  ];

  function turnRefusalText(payload, status) {
    var code = payload && payload.problem ? payload.problem.code : "";
    if (code === "turn-conflict") {
      return "busy: another turn holds this project";
    }
    if (code === "no-active-generation") {
      return "no active generation: activate one in the generation controls";
    }
    if (code === "stale-revision") {
      return "conflict: this thread moved on; reload the project";
    }
    return problemText(payload, status);
  }

  function terminalText(frame) {
    if (frame.kind === "saved") {
      return (
        "saved · revision " + text(frame.revision) + " · " + text(frame.messageCount) +
        " messages · " + (frame.credited ? "counted as a completed real turn" : "not counted")
      );
    }
    if (frame.kind === "turn-failed") {
      return "failed: " + text(frame.code) +
        (frame.saved ? " · saved at revision " + text(frame.revision) : " · not saved");
    }
    if (frame.kind === "turn-rejected") {
      return "rejected: " + text(frame.code);
    }
    if (frame.kind === "save-failed") {
      return "not saved: " + text(frame.code);
    }
    if (frame.kind === "stream-invalid") {
      return "unreadable turn stream: " + text(frame.code);
    }
    return frame.kind === "cancelled" ? "cancelled" : "timed out";
  }

  function assistantDelta(value) {
    if (typeof value !== "string" || value === "") {
      return;
    }
    if (page.assistantText === null) {
      page.assistantText = textMessage("assistant", "assistant", "");
    }
    page.assistantText.appendChild(document.createTextNode(value));
  }

  function renderTerminal(frame) {
    var wording = terminalText(frame);
    setText("${ID.turnState}", wording);
    var entry = messageEntry(frame.kind === "saved" ? "terminal" : "terminal problem", "turn");
    var body = element("pre", "text");
    body.textContent = wording;
    entry.appendChild(body);
    page.assistantText = null;
  }

  /** Apply one proven frame, and answer whether it ended the turn. */
  function applyFrame(frame) {
    if (!frame || typeof frame.kind !== "string") {
      return false;
    }
    if (frame.kind === "text") {
      assistantDelta(frame.text);
      return false;
    }
    if (frame.kind === "tool-start") {
      page.assistantText = null;
      toolBlock(text(frame.toolCallId), text(frame.toolName), frame.arguments);
      return false;
    }
    if (frame.kind === "tool-result") {
      page.assistantText = null;
      toolResult(frame);
      return false;
    }
    if (frame.kind === "diff") {
      page.assistantText = null;
      diffMessage(frame);
      return false;
    }
    if (frame.kind === "diff-unavailable") {
      page.assistantText = null;
      diffUnavailableMessage(frame);
      return false;
    }
    if (TERMINAL_KINDS.indexOf(frame.kind) < 0) {
      return false;
    }
    renderTerminal(frame);
    return true;
  }

  function applyLine(line) {
    if (line.trim() === "") {
      return false;
    }
    var frame = null;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      frame = null;
    }
    if (frame === null) {
      setText("${ID.turnState}", "unreadable frame from this Worker");
      return false;
    }
    return applyFrame(frame);
  }

  async function readFrames(body, token) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var ended = false;
    for (;;) {
      var chunk = await reader.read();
      if (token !== page.selection) {
        await reader.cancel();
        return true;
      }
      if (chunk.done) {
        return ended;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        var newline = buffer.indexOf("\\n");
        if (newline < 0) {
          break;
        }
        var line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (applyLine(line)) {
          ended = true;
        }
      }
    }
  }

  function turnRunning(running) {
    page.turnActive = running;
    var send = node("${ID.sendTurnButton}");
    var cancel = node("${ID.cancelTurnButton}");
    if (send !== null) {
      send.disabled = running;
    }
    if (cancel !== null) {
      cancel.disabled = !running;
    }
  }

  function cancelActiveTurn() {
    if (page.turn !== null) {
      page.turn.abort();
      page.turn = null;
    }
  }

  function cancelTurn() {
    if (page.turn !== null) {
      setText("${ID.turnState}", "cancelling");
      page.turn.abort();
    }
  }

  async function streamTurn(projectId, prompt, token, controller) {
    var response = await fetch(projectPath(projectId, "/turn"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ prompt: prompt }),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      var payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      setText("${ID.turnState}", turnRefusalText(payload, response.status));
      return;
    }
    var ended = await readFrames(response.body, token);
    if (!ended && token === page.selection) {
      setText("${ID.turnState}", "the turn stream ended without a terminal frame");
    }
  }

  async function sendTurn() {
    clearError();
    var projectId = page.projectId;
    if (projectId === null) {
      setText("${ID.turnState}", "select a project first");
      return;
    }
    if (page.turnActive) {
      setText("${ID.turnState}", "a turn is already running");
      return;
    }
    var prompt = inputValue("${ID.promptInput}");
    if (prompt === "") {
      setText("${ID.turnState}", "type a prompt first");
      return;
    }

    var token = page.selection;
    var controller = new AbortController();
    page.turn = controller;
    page.freshArmed = false;
    turnRunning(true);
    setText("${ID.turnState}", "running");
    setText("${ID.freshThreadStatus}", "");
    textMessage("user", "you", prompt);
    page.assistantText = null;
    var input = node("${ID.promptInput}");
    if (input !== null) {
      input.value = "";
    }

    try {
      await streamTurn(projectId, prompt, token, controller);
    } catch (error) {
      if (token === page.selection) {
        setText(
          "${ID.turnState}",
          controller.signal.aborted
            ? "cancelled: this browser stopped the turn"
            : "disconnected: the turn stream ended early",
        );
        if (!controller.signal.aborted) {
          reportError("the turn request", error);
        }
      }
    } finally {
      page.turn = null;
      turnRunning(false);
      if (token === page.selection) {
        void loadThread(true);
      }
    }
  }
`;
