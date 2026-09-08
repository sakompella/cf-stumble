import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * Measured facts about the rendered page: boxes, overflow, and internal scrolling.
 *
 * Measured, not assumed: a collapsed sidebar has no box whatever its class says, two columns are
 * side by side only when one really ends before the other begins, and a transcript is bounded only
 * when the page has a scroll box rather than a taller document.
 */

export type LayoutSnapshot = Readonly<{
  layoutClass: string;
  sidebarWidth: number;
  sidebarRight: number;
  sidebarBottom: number;
  conversationWidth: number;
  conversationLeft: number;
  conversationTop: number;
  viewportWidth: number;
  viewportHeight: number;
  toggleExpanded: string;
  toggleLabel: string;
  drawerOpen: boolean;
}>;

export function readLayout(page: BrowserPage): Promise<LayoutSnapshot> {
  return page.evaluate<LayoutSnapshot>(`(() => {
    const box = (id) => {
      const found = document.getElementById(id);
      if (found === null) { return null; }
      const rect = found.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0 ? null : rect;
    };
    const aside = box("${ID.sidebar}");
    const main = box("${ID.conversation}");
    const toggle = document.getElementById("${ID.sidebarToggle}");
    const drawer = document.getElementById("${ID.generationDrawer}");
    return {
      layoutClass: document.getElementById("${ID.layout}")?.className ?? "",
      sidebarWidth: aside === null ? 0 : aside.width,
      sidebarRight: aside === null ? 0 : aside.right,
      sidebarBottom: aside === null ? 0 : aside.bottom,
      conversationWidth: main === null ? 0 : main.width,
      conversationLeft: main === null ? 0 : main.left,
      conversationTop: main === null ? 0 : main.top,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      toggleExpanded: toggle?.getAttribute("aria-expanded") ?? "",
      toggleLabel: toggle?.textContent ?? "",
      drawerOpen: drawer === null ? false : drawer.open,
    };
  })()`);
}

/** One element's box. `visible` is the fact a real mouse click depends on. */
export type BoxSnapshot = Readonly<{
  present: boolean;
  visible: boolean;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export function readBox(page: BrowserPage, selector: string): Promise<BoxSnapshot> {
  return page.evaluate<BoxSnapshot>(`(() => {
    const found = document.querySelector(${JSON.stringify(selector)});
    if (found === null) {
      return { present: false, visible: false, width: 0, height: 0,
        top: 0, right: 0, bottom: 0, left: 0 };
    }
    const rect = found.getBoundingClientRect();
    const style = getComputedStyle(found);
    return {
      present: true,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
        style.display !== "none",
      width: rect.width, height: rect.height,
      top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
    };
  })()`);
}

export type PageMetrics = Readonly<{
  scrollWidth: number;
  clientWidth: number;
  horizontalOverflow: number;
  scrollHeight: number;
  clientHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  bodyWidth: number;
  bodyLeft: number;
}>;

export function readPageMetrics(page: BrowserPage): Promise<PageMetrics> {
  return page.evaluate<PageMetrics>(`(() => {
    const root = document.documentElement;
    const body = document.body.getBoundingClientRect();
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyWidth: body.width,
      bodyLeft: body.left,
    };
  })()`);
}

/** Whether an element scrolls its own content, which is what bounds a long transcript. */
export type ScrollSnapshot = Readonly<{
  present: boolean;
  scrollHeight: number;
  clientHeight: number;
  height: number;
  scrollable: boolean;
  overflowY: string;
}>;

export function readScroll(page: BrowserPage, elementId: string): Promise<ScrollSnapshot> {
  return page.evaluate<ScrollSnapshot>(`(() => {
    const found = document.getElementById(${JSON.stringify(elementId)});
    if (found === null) {
      return { present: false, scrollHeight: 0, clientHeight: 0, height: 0,
        scrollable: false, overflowY: "" };
    }
    const style = getComputedStyle(found);
    return {
      present: true,
      scrollHeight: found.scrollHeight,
      clientHeight: found.clientHeight,
      height: found.getBoundingClientRect().height,
      scrollable: found.scrollHeight > found.clientHeight + 1,
      overflowY: style.overflowY,
    };
  })()`);
}

export type FocusSnapshot = Readonly<{
  id: string;
  tag: string;
  className: string;
  projectId: string;
  text: string;
  visible: boolean;
  outlineStyle: string;
  outlineWidth: number;
  boxShadow: string;
}>;

/** What holds focus, and whether a reader can see that it does. */
export function readFocus(page: BrowserPage): Promise<FocusSnapshot> {
  return page.evaluate<FocusSnapshot>(`(() => {
    const active = document.activeElement;
    if (active === null) {
      return { id: "", tag: "", className: "", projectId: "", text: "",
        visible: false, outlineStyle: "", outlineWidth: 0, boxShadow: "" };
    }
    const rect = active.getBoundingClientRect();
    const style = getComputedStyle(active);
    return {
      id: active.id,
      tag: active.tagName.toLowerCase(),
      className: active.className,
      projectId: active.getAttribute("data-project-id") ?? "",
      text: active.textContent ?? "",
      visible: rect.width > 0 && rect.height > 0,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      boxShadow: style.boxShadow,
    };
  })()`);
}
