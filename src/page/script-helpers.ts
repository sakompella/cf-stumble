import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * The shared part of the inline script: element access, the one JSON fetch helper, the mutable
 * page state, and the way a failure is worded. Every request is a same-origin relative path and
 * carries the Access session cookie the browser already holds, so the page asks for no credential
 * and stores none.
 *
 * `page.selection` is the guard that keeps a turn's frames in the conversation they belong to.
 * Selecting a project increments it, and every asynchronous renderer captures the number it started
 * with; a frame or a thread read that arrives after a switch finds a different number and is
 * dropped rather than appended to the newly selected project's conversation.
 *
 * Identifiers are interpolated from `element-ids.ts`, so the markup and the script cannot disagree.
 * The script text uses no JavaScript template literal, so every `${...}` below is a deliberate
 * TypeScript interpolation.
 */
export const OWNER_PAGE_SCRIPT_HELPERS = `
  var page = {
    projectId: null,
    projectName: "",
    selection: 0,
    turn: null,
    turnActive: false,
    tools: null,
    assistantText: null,
    freshArmed: false,
  };

  function node(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var target = node(id);
    if (target !== null) {
      target.textContent = value;
    }
  }

  function inputValue(id) {
    var target = node(id);
    return target === null ? "" : target.value.trim();
  }

  function text(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function element(tag, className) {
    var created = document.createElement(tag);
    if (className !== undefined) {
      created.className = className;
    }
    return created;
  }

  function reportError(where, error) {
    var detail = error && error.message ? error.message : String(error);
    setText("${ID.pageError}", where + " could not reach this Worker: " + detail);
  }

  function clearError() {
    setText("${ID.pageError}", "");
  }

  function problemText(payload, status) {
    if (payload && payload.problem && payload.problem.code) {
      return "rejected: " + payload.problem.code;
    }
    if (payload && payload.error && payload.error.code) {
      return "error: " + payload.error.code;
    }
    return "error: HTTP " + status;
  }

  // Relative paths keep every call on this origin, and the Content Security Policy refuses others.
  async function call(method, path, body) {
    var init = {
      method: method,
      credentials: "same-origin",
      headers: { accept: "application/json" },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var response = await fetch(path, init);
    var payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    return { status: response.status, payload: payload };
  }

  function projectPath(projectId, suffix) {
    return "/api/projects/" + encodeURIComponent(projectId) + suffix;
  }
`;
