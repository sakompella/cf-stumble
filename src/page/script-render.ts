import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * How the transcript is built. Both readers use it: the saved conversation a project selection
 * loads, and the frames a running turn appends (ADR-0037).
 *
 * Nothing here ever assigns HTML. Every value that came from a repository, a command, or a model
 * is written with `textContent` or a text node, so repository content and model output are text and
 * cannot become markup this page executes.
 *
 * Two bounds keep a long turn readable and the page responsive. A tool result is collapsed by
 * default, so a hundred-line command output costs one summary line until a reader opens it; the
 * Supervisor already bounds what a tool may return, and this second bound covers what the browser
 * lays out. A result that looks like a unified diff is rendered line by line with its adds and
 * removes marked, which is what makes goal criterion 4's diff readable rather than a wall of text.
 */
export const OWNER_PAGE_SCRIPT_RENDER = `
  var DISPLAY_MAX_CHARACTERS = 20000;
  var DISPLAY_MAX_LINES = 400;

  function messageList() {
    return node("${ID.messageList}");
  }

  function clearConversation() {
    var list = messageList();
    if (list !== null) {
      list.textContent = "";
    }
    page.tools = Object.create(null);
    page.assistantText = null;
  }

  function appendEntry(entry) {
    var list = messageList();
    if (list === null) {
      return;
    }
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(entry);
    if (atBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function messageEntry(role, who) {
    var entry = element("li", "${CLASS.message} " + role);
    var label = element("span", "who");
    label.textContent = who;
    entry.appendChild(label);
    appendEntry(entry);
    return entry;
  }

  function textMessage(role, who, value) {
    var entry = messageEntry(role, who);
    var body = element("pre", "text");
    body.textContent = value;
    entry.appendChild(body);
    return body;
  }

  // What the page will lay out, whatever the server allowed itself to send.
  function boundedLines(value) {
    var shortened = value.length > DISPLAY_MAX_CHARACTERS
      ? value.slice(0, DISPLAY_MAX_CHARACTERS)
      : value;
    var lines = shortened.split("\\n");
    var kept = lines.length > DISPLAY_MAX_LINES ? lines.slice(0, DISPLAY_MAX_LINES) : lines;
    var dropped = lines.length - kept.length + (value.length - shortened.length > 0 ? 1 : 0);
    return { lines: kept, shortened: dropped > 0 };
  }

  function looksLikeDiff(value) {
    return /^(diff --git |@@ |\\+\\+\\+ |--- )/m.test(value);
  }

  function diffClass(line) {
    if (line.indexOf("@@") === 0) return "${CLASS.diffLine} hunk";
    if (line.indexOf("+++") === 0 || line.indexOf("---") === 0) return "${CLASS.diffLine} hunk";
    if (line.indexOf("+") === 0) return "${CLASS.diffLine} added";
    if (line.indexOf("-") === 0) return "${CLASS.diffLine} removed";
    return "${CLASS.diffLine}";
  }

  function renderOutput(target, content) {
    var bounded = boundedLines(content);
    if (looksLikeDiff(content)) {
      for (var index = 0; index < bounded.lines.length; index += 1) {
        var row = element("span", diffClass(bounded.lines[index]));
        row.textContent = bounded.lines[index] + "\\n";
        target.appendChild(row);
      }
    } else {
      target.appendChild(document.createTextNode(bounded.lines.join("\\n")));
    }
    if (bounded.shortened) {
      var note = element("span", "note");
      note.textContent = "\\n… shortened for display";
      target.appendChild(note);
    }
  }

  function toolSummaryText(toolName, args) {
    var described = "";
    try {
      described = args ? JSON.stringify(args) : "";
    } catch (error) {
      described = "";
    }
    return toolName + (described === "" || described === "{}" ? "" : " " + described.slice(0, 160));
  }

  // One collapsible per tool call, opened by the reader rather than by the page.
  function toolBlock(toolCallId, toolName, args) {
    var entry = messageEntry("tool", "tool call");
    var block = element("details", "${CLASS.toolCall}");
    var summary = element("summary");
    summary.textContent = toolSummaryText(toolName, args);
    var output = element("pre", "${CLASS.toolOutput}");
    output.textContent = "running…";
    block.appendChild(summary);
    block.appendChild(output);
    entry.appendChild(block);
    var parts = { block: block, summary: summary, output: output };
    if (page.tools === null) {
      page.tools = Object.create(null);
    }
    page.tools[toolCallId] = parts;
    return parts;
  }

  // A result whose start frame never arrived still has to be readable, so it gets a block now.
  function toolParts(toolCallId, toolName) {
    var held = page.tools === null ? undefined : page.tools[toolCallId];
    return held === undefined ? toolBlock(toolCallId, toolName, undefined) : held;
  }

  function toolResult(frame) {
    var parts = toolParts(frame.toolCallId, frame.toolName);
    var block = parts.block;
    parts.output.textContent = "";
    renderOutput(parts.output, frame.content);
    if (frame.truncated) {
      var note = element("span", "note");
      note.textContent = "\\n… the server truncated this output";
      parts.output.appendChild(note);
    }
    parts.summary.textContent = frame.toolName + (frame.isError ? " — failed" : " — done");
    block.className = frame.isError ? "${CLASS.toolCall} failed" : "${CLASS.toolCall}";
    if (frame.isError) {
      block.open = true;
    }
  }
`;
