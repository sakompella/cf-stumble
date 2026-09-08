import type { BrowserPage } from "./chrome.mjs";

/**
 * The accessible role and name the browser itself computes.
 *
 * A case that read `textContent` would accept a button labelled by a stray whitespace node and
 * reject one labelled by `aria-label`, so the name comes from Chrome's own accessibility tree
 * instead. That is the same computation a screen reader performs, which is what KEY-1 is asking
 * about when it says every tab stop must be correctly named.
 */

export type AccessibleNode = Readonly<{ role: string; name: string; ignored: boolean }>;

const MISSING: AccessibleNode = { role: "", name: "", ignored: true };

async function accessibleNodeOf(page: BrowserPage, expression: string): Promise<AccessibleNode> {
  const evaluated = await page.command("Runtime.evaluate", { expression, returnByValue: false });
  const objectId = evaluated.text("result.objectId");
  if (objectId === undefined) {
    return MISSING;
  }
  try {
    const requested = await page.command("DOM.requestNode", { objectId });
    const nodeId = requested.count("nodeId");
    if (nodeId === undefined || nodeId === 0) {
      return MISSING;
    }
    const tree = await page.command("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    return {
      role: tree.text("nodes.0.role.value") ?? "",
      name: tree.text("nodes.0.name.value") ?? "",
      ignored: tree.value("nodes.0.ignored") === true,
    };
  } finally {
    await page.command("Runtime.releaseObject", { objectId });
  }
}

export function readAccessibleNode(page: BrowserPage, selector: string): Promise<AccessibleNode> {
  return accessibleNodeOf(page, `document.querySelector(${JSON.stringify(selector)})`);
}

/** The role and name of whatever holds focus, which is what a tab-order case walks. */
export function readFocusedAccessibleNode(page: BrowserPage): Promise<AccessibleNode> {
  return accessibleNodeOf(page, "document.activeElement");
}
