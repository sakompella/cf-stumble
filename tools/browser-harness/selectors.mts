import { OWNER_PAGE_CLASSES as CLASS } from "../../src/page/element-ids.js";

/**
 * The selectors a case names, built from the page's own identifier contract.
 *
 * A case may select by identifier or class, because those are exported from
 * `src/page/element-ids.ts` and a rename breaks the harness at compile time. What a case may not
 * do is assert on one: the assertion has to read what the element renders, or the case would prove
 * only that a name still exists.
 */

export function byId(elementId: string): string {
  return `#${elementId}`;
}

export const TOOL_DISCLOSURE = `details.${CLASS.toolCall}`;
export const TOOL_SUMMARY = `details.${CLASS.toolCall} summary`;
export const PROJECT_BUTTON = `.${CLASS.projectButton}`;

export function projectButton(projectId: string): string {
  return `.${CLASS.projectButton}[data-project-id="${projectId}"]`;
}

export function nth(selector: string, index: number): string {
  return `${selector}:nth-of-type(${index + 1})`;
}
