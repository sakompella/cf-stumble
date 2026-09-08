import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/**
 * Reading `GET /api/status`, which renders recorded facts into elements. The epoch rendered here
 * is the one activation and rollback later send, so what the page shows is what it uses
 * (ADR-0033).
 */
export const OWNER_PAGE_SCRIPT_STATUS = `
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
`;
