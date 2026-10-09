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

/** The role and name of whatever holds focus, which is what a tab-order case walks. */
export async function readFocusedAccessibleNode(page: BrowserPage): Promise<AccessibleNode> {
  const evaluated = await page.command("Runtime.evaluate", {
    expression: "document.activeElement",
    returnByValue: false,
  });

  const objectId = evaluated.text("result.objectId");

  if (objectId === undefined) {
    return { role: "", name: "", ignored: true };
  }

  try {
    const tree = await page.command("Accessibility.getPartialAXTree", {
      objectId,
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
