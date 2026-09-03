import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * The shared part of the inline script: element access, the one fetch helper, and the way a
 * failure is worded. Every request is a same-origin relative path and carries the Access session
 * cookie the browser already holds, so the page asks for no credential and stores none.
 *
 * Identifiers are interpolated from `element-ids.ts`, so the markup and the script cannot
 * disagree. The script text uses no JavaScript template literal, so every `${...}` below is a
 * deliberate TypeScript interpolation.
 */
export const OWNER_PAGE_SCRIPT_HELPERS = `
  function node(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var target = node(id);
    if (target !== null) {
      target.textContent = value;
    }
  }

  function setRaw(id, value) {
    setText(id, value === null || value === undefined ? "" : JSON.stringify(value, null, 2));
  }

  function inputValue(id) {
    var target = node(id);
    return target === null ? "" : target.value.trim();
  }

  function text(value) {
    return value === null || value === undefined ? "" : String(value);
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

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "request-" + Date.now() + "-" + Math.floor(Math.random() * 1000000000);
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
`;
