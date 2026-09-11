// oxlint-disable import/max-dependencies -- One facade so a surface file imports one module. The dependency count is the point: it is here instead of in every case file.
export { OWNER_PAGE_CLASSES, OWNER_PAGE_IDS } from "../../src/page/element-ids.js";

export * from "./case.mjs";

export * from "./expect.mjs";

export * from "./fixtures.mjs";

export * from "./fixtures-generation.mjs";

export * from "./fixtures-thread.mjs";

export * from "./page-accessibility.mjs";

export * from "./page-actions.mjs";

export * from "./page-layout.mjs";

export * from "./page-projects.mjs";

export * from "./page-queries.mjs";

export * from "./page-transcript.mjs";

export * from "./page-wait.mjs";

export * from "./selectors.mjs";

export type { GenerationPatch, HarnessServer } from "./server.mjs";

export type { RecordedRequest } from "./server-state.mjs";

export { FRAME_INTERVAL_MS } from "./server-turn.mjs";

export {
  EXTERNAL_LATE_MARKER,
  LONG_LINE_CHARACTERS,
  LONG_LINE_END_MARKER,
  LONG_LINE_START_MARKER,
  MARKUP_IMAGE_TEXT,
  MARKUP_SCRIPT_TEXT,
  RETAINED_EDIT_MARKER,
} from "./turn-parts.mjs";

export type { BrowserPage, ElementBox, HarnessKey, HarnessModifier } from "./chrome.mjs";

/**
 * Everything a surface file needs, in one import.
 *
 * Six surfaces are written by six agents against this one module, so the import list of a case
 * file is not where their work should collide. It also states the contract in one place: what is
 * exported here is what a case may use, and a case that needs something else needs a new reader
 * rather than a private path into the driver.
 */
