import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * Generation controls: submit a harness commit as a candidate, activate a generation, and roll
 * back. Activation and rollback send the epoch the status endpoint reported and the page
 * rendered, and each records its result where a reader can see it. There is no request id: the
 * Supervisor applies each command directly (ADR-0030), so a repeated submission returns the
 * existing generation, and activating the already-active generation with the current epoch is a
 * no-op.
 */
export const OWNER_PAGE_SCRIPT_GENERATIONS = `
  function renderSubmission(result) {
    var payload = result.payload;
    if (!payload || payload.ok !== true) {
      setText("${ID.submitStatus}", problemText(payload, result.status));
      renderDiagnostics(null);
      return;
    }
    setText("${ID.submitStatus}", "ok");
    setText("${ID.submitGenerationLabel}", text(payload.outcome.generation.label));
    setText("${ID.submitEpoch}", text(payload.outcome.epoch));
    setText("${ID.submitPreparation}", preparationText(payload.preparation));
    renderDiagnostics(payload.preparation);
  }

  // The tail of a failed build step. It is untrusted command output, so it only ever goes through
  // textContent, and the details element stays closed until the reader opens it.
  function renderDiagnostics(preparation) {
    var box = node("${ID.submitDiagnostics}");
    var diagnostics = preparation && preparation.ok === false && preparation.problem
      ? preparation.problem.diagnostics
      : null;
    if (box === null) {
      return;
    }
    if (!diagnostics) {
      box.hidden = true;
      box.open = false;
      setText("${ID.submitDiagnosticsText}", "");
      return;
    }
    var parts = [];
    if (diagnostics.stderrTail) {
      parts.push("stderr:\\n" + text(diagnostics.stderrTail));
    }
    if (diagnostics.stdoutTail) {
      parts.push("stdout:\\n" + text(diagnostics.stdoutTail));
    }
    if (diagnostics.truncated === true) {
      parts.push("(output truncated to the last part of each stream)");
    }
    setText("${ID.submitDiagnosticsText}", parts.join("\\n\\n"));
    box.hidden = false;
    box.open = false;
  }

  function preparationText(preparation) {
    if (!preparation) {
      return "";
    }
    if (preparation.ok === true) {
      return preparation.report.stage + ": " + text(preparation.report.reason);
    }
    return "rejected: " + text(preparation.problem.code);
  }

  async function submitCandidate() {
    clearError();
    var harnessCommit = inputValue("${ID.candidateCommitInput}");
    if (harnessCommit === "") {
      setText("${ID.submitStatus}", "enter a harness commit first");
      return;
    }
    setText("${ID.submitStatus}", "running");
    renderDiagnostics(null);
    try {
      var body = { harnessCommit: harnessCommit };
      renderSubmission(await call("POST", "/api/generations/submit", body));
      await refreshStatus();
    } catch (error) {
      setText("${ID.submitStatus}", "request failed");
      renderDiagnostics(null);
      reportError("the submission request", error);
    }
  }

  // The epoch comes from what the status endpoint reported and this page rendered, never a guess.
  function observedEpoch() {
    var shown = node("${ID.generationEpoch}");
    var parsed = Number.parseInt(shown === null ? "" : shown.textContent, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function controlIds(kind) {
    return kind === "activate"
      ? {
          labelInput: "${ID.activateLabelInput}",
          status: "${ID.activateStatus}",
          sentEpoch: "${ID.activateSentEpoch}",
          effect: "${ID.activateEffect}",
        }
      : {
          labelInput: "${ID.rollbackLabelInput}",
          status: "${ID.rollbackStatus}",
          sentEpoch: "${ID.rollbackSentEpoch}",
          effect: "${ID.rollbackEffect}",
        };
  }

  // A generation label names one whole generation. "1.5" names none, and Number.parseInt would
  // read it as 1 and send a command the reader never asked for.
  function controlLabel(raw) {
    var trimmed = String(raw).trim();
    if (trimmed === "") {
      return null;
    }
    var parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function renderControl(ids, result) {
    var payload = result.payload;
    if (!payload || payload.ok !== true) {
      setText(ids.status, problemText(payload, result.status));
      setText(ids.effect, "");
      return;
    }
    setText(ids.status, "ok");
    setText(ids.effect, text(payload.outcome.effect));
  }

  // After a request whose transport outcome is uncertain, refresh status before sending another
  // activation or rollback rather than guessing what happened from here.
  async function runControl(kind) {
    clearError();
    var ids = controlIds(kind);
    var epoch = observedEpoch();
    if (epoch === null) {
      setText(ids.status, "refresh the status first");
      return;
    }
    var label = controlLabel(inputValue(ids.labelInput));
    if (label === null) {
      setText(ids.status, "enter a generation label");
      return;
    }
    setText(ids.sentEpoch, String(epoch));
    setText(ids.status, "running");
    try {
      var body = { observedEpoch: epoch, label: label };
      renderControl(ids, await call("POST", "/api/generations/" + kind, body));
      await refreshStatus();
    } catch (error) {
      setText(ids.status, "request failed");
      reportError("the " + kind + " request", error);
    }
  }
`;
