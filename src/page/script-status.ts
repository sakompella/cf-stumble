import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * Reading `GET /api/status` and `GET /api/recovery/latest`. Both render recorded facts into
 * elements. The epoch rendered here is the one activation and rollback later send, so what the page
 * shows is what it uses (ADR-0033).
 *
 * The recovery panel states what was recorded and nothing more. It never says a generation is
 * known-good and never implies a repair is running, because cf-stumble performs none: the way back
 * to working code is the manual rollback in the same drawer (ADR-0032).
 */
export const OWNER_PAGE_SCRIPT_STATUS = `
  function renderRecovery(report) {
    setText("${ID.recoveryPresence}", report ? "recorded" : "none recorded");
    setText("${ID.recoveryId}", report ? String(report.id) : "");
    setText("${ID.recoveryPhase}", report ? text(report.phase) : "");
    setText("${ID.recoveryResult}", report ? text(report.result) : "");
    setText("${ID.recoveryFailedLabel}", report ? text(report.failedGenerationLabel) : "");
    setText("${ID.recoveryFallbackLabel}", report ? text(report.fallbackGenerationLabel) : "");
    setText("${ID.recoveryAttempts}", report ? text(report.attemptsUsed) : "");
    setText("${ID.recoveryErrorCount}", report ? text(report.errorCount) : "");
    setText("${ID.recoveryStartedAt}", report ? text(report.startedAt) : "");
    setText("${ID.recoveryAwaiting}", report ? text(report.awaitingExternalReport) : "");
  }

  function renderStatus(result) {
    var payload = result.payload;
    var active = payload && payload.activeGeneration ? payload.activeGeneration : null;
    if (active === null) {
      setText("${ID.statusStatus}", problemText(payload, result.status));
      return;
    }
    var generation = active.generation ? active.generation : null;
    setText("${ID.activeGenerationLabel}", generation ? String(generation.label) : "none");
    setText("${ID.activeGenerationCommit}", generation ? text(generation.harnessCommit) : "none");
    setText("${ID.activeGenerationStatus}", generation ? text(generation.status) : "none active");
    setText("${ID.generationEpoch}", String(active.epoch));
    setText("${ID.statusStatus}", "ok");
    renderRecovery(payload.latestRecoveryReport);
  }

  async function refreshStatus() {
    clearError();
    setText("${ID.statusStatus}", "reading");
    try {
      renderStatus(await call("GET", "/api/status"));
    } catch (error) {
      setText("${ID.statusStatus}", "request failed");
      reportError("the status request", error);
    }
  }

  async function refreshRecovery() {
    clearError();
    try {
      var result = await call("GET", "/api/recovery/latest");
      var payload = result.payload;
      if (payload && payload.ok === true) {
        renderRecovery(payload.report);
        return;
      }
      renderRecovery(null);
      setText("${ID.recoveryPresence}", problemText(payload, result.status));
    } catch (error) {
      setText("${ID.recoveryPresence}", "request failed");
      reportError("the recovery report request", error);
    }
  }
`;
