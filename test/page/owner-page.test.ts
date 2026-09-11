/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * What the owner page is made of: the sidebar of connected projects, the streaming conversation,
 * the collapsible tool detail, and the generation drawer (goal criterion 4, Q4).
 *
 * These tests read the document the browser receives. They cannot prove the page behaves, because
 * no DOM runs here — that is the browser harness in `tools/browser-harness/`. What they hold is
 * everything a text can hold: the identifiers a browser test acts on, the endpoints the page calls,
 * the frame vocabulary it understands, and the two rules that keep repository and model output from
 * becoming markup this page executes.
 */

import { expect, test } from "vitest";
import { ownerPageHtml, OWNER_PAGE_ELEMENT_IDS, OWNER_PAGE_IDS } from "../../src/page/index.js";
import { HARNESS_DIRECTORY } from "../../src/workspace-layout.js";

/** The script the browser actually receives, taken out of the one inline `<script>` element. */
function inlinePageScript(html: string): string {
  const found = /<script nonce="[^"]*">([\s\S]*?)<\/script>/u.exec(html);

  if (found?.[1] === undefined) {
    throw new Error("the owner page carries no inline script");
  }

  return found[1];
}

test("the page markup carries every stable element id", () => {
  const html = ownerPageHtml("test-nonce");

  for (const id of OWNER_PAGE_ELEMENT_IDS) {
    expect(html, `missing id ${id}`).toContain(`id="${id}"`);
  }

  expect(OWNER_PAGE_ELEMENT_IDS.length).toBe(new Set(OWNER_PAGE_ELEMENT_IDS).size);
});

test("the inline script the browser receives parses as JavaScript", () => {
  // Every other assertion in this file matches text, and text matching cannot see a syntax
  // error: each id still appears in the markup while none of the script runs, so the page looks
  // right and populates nothing. Parsing the delivered script is the only check that the page
  // can fill itself in at all.
  const script = inlinePageScript(ownerPageHtml("test-nonce"));

  expect(script).toContain("refreshStatus");
  expect(script).toContain("sendTurn");
  expect(script).toContain("loadProjects");
  // oxlint-disable-next-line typescript/no-implied-eval -- Constructing the function is the check. It parses the script and is never called.
  expect(() => new Function(script)).not.toThrow();
});

test("the page uses only the owner JSON endpoints, on this origin", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).toContain('"/api/status"');
  expect(html).toContain('"/api/projects"');
  expect(html).toContain('"/api/projects/"');
  expect(html).toContain('"/thread"');
  expect(html).toContain('"/thread/fresh"');
  expect(html).toContain('"/turn"');
  expect(html).toContain('"/api/projects/connect"');
  expect(html).toContain('"/api/github/authorization"');
  expect(html).toContain('"/api/generations/submit"');
  expect(html).toContain('"/api/generations/" + kind');
  expect(html).not.toMatch(/https?:\/\/(?!cf-stumble\.test)/u);
});

test("a project is chosen from the tenant's catalog, never typed in", () => {
  const html = ownerPageHtml("test-nonce");

  // T6a made the catalog real, so a project id is something the Supervisor already holds. A
  // free-text field could only name a project the tenant has not connected, and the default value
  // this page used to carry named a placeholder that no longer exists.
  expect(html).toContain(`id="${OWNER_PAGE_IDS.projectList}"`);
  expect(html).not.toContain("project-one");
  expect(html).not.toContain('id="project-id-input"');
  expect(html).not.toContain("input-project");
});

test("the sidebar can show an entry that is a checkout rather than a connection", () => {
  const script = inlinePageScript(ownerPageHtml("test-nonce"));

  // The harness entry arrives in the same list with `kind: "harness"` and no repository URL, so
  // the sidebar has to name the checkout it selects and must not count it as a connection: a page
  // that read `repositoryUrl` for every row would show the owner an empty line and "1 connected"
  // on a deployment where nothing is connected.
  expect(script).toContain(`"${HARNESS_DIRECTORY}"`);
  expect(script).toContain('"harness"');
  expect(script).toContain("no repository connected yet");
});

test("the streaming client reads the frames the turn route emits", () => {
  const script = inlinePageScript(ownerPageHtml("test-nonce"));

  // The vocabulary is `ProjectTurnFrame` in supervisor/projects/turn-frames.ts. A kind this page
  // does not handle is a frame the owner would never see, so every one is named here.
  for (const kind of [
    "text",
    "tool-start",
    "tool-result",
    "diff",
    "diff-unavailable",
    "saved",
    "turn-failed",
    "turn-rejected",
    "save-failed",
    "stream-invalid",
    "cancelled",
    "timed-out",
  ]) {
    expect(script, `no handling for frame kind ${kind}`).toContain(`"${kind}"`);
  }

  // Reading the body while it arrives is what makes the conversation stream rather than appear in
  // one block when the turn ends (ADR-0037).
  expect(script).toContain("getReader()");
  expect(script).toContain("application/x-ndjson");
  expect(script).toContain("AbortController");
});

test("a turn's diff renders with the tool-result colouring, and an unavailable diff states why", () => {
  const script = inlinePageScript(ownerPageHtml("test-nonce"));

  // T13 added `diff` (`content`, `truncated`) and `diff-unavailable` (`detail`) to
  // `FacetTurnFrame`/`ProjectTurnFrame`. Both must render: a diff reuses the bounded, coloured
  // output every other frame gets, and a stated reason replaces a silent, empty diff.
  expect(script).toContain('frame.kind === "diff"');
  expect(script).toContain('frame.kind === "diff-unavailable"');
  expect(script).toContain("diffMessage(frame)");
  expect(script).toContain("diffUnavailableMessage(frame)");
  expect(script).toContain("frame.detail");
  expect(script).toContain("the harness truncated this diff");
});

test("the page never turns repository or model output into markup", () => {
  const script = inlinePageScript(ownerPageHtml("test-nonce"));

  // Everything a turn shows — text, tool arguments, command output, a diff — came from a
  // repository or a model. It reaches the document as text nodes and `textContent` only.
  expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  expect(script).not.toContain("eval(");
  expect(script).toContain("createTextNode");
  expect(script).toContain("textContent");
});

test("every element the script reads is an element the markup renders", () => {
  const html = ownerPageHtml("test-nonce");
  const script = inlinePageScript(html);
  const known = new Set<string>(OWNER_PAGE_ELEMENT_IDS);

  // The script names elements through `node(id)` and `setText(id, ...)`. A literal here that the
  // markup does not carry is a silent no-op at run time, which looks like a page that renders
  // nothing rather than like a fault.
  for (const found of script.matchAll(/(?:node|setText)\("([a-z-]+)"/gu)) {
    const id = found[1] ?? "";
    expect(known.has(id), `the script reads an element the markup lacks: ${id}`).toBe(true);
  }
});

test("the sidebar collapses and the generation controls stay in a drawer", () => {
  const html = ownerPageHtml("test-nonce");

  // Q4: the active generation stays visible, and submission, activation and rollback sit in a
  // compact drawer on the same page.
  expect(html).toContain(`id="${OWNER_PAGE_IDS.sidebarToggle}"`);
  expect(html).toContain(`aria-controls="${OWNER_PAGE_IDS.sidebar}"`);
  expect(html).toContain(`aria-expanded="true"`);
  expect(html).toContain(`<details id="${OWNER_PAGE_IDS.generationDrawer}">`);
  expect(html).toContain(`id="${OWNER_PAGE_IDS.activeGenerationLabel}"`);
  expect(html).toContain(`id="${OWNER_PAGE_IDS.generationEpoch}"`);
  expect(html).toContain(`id="${OWNER_PAGE_IDS.rollbackButton}"`);
});

test("starting a fresh thread takes a second, deliberate click", () => {
  const html = ownerPageHtml("test-nonce");
  const script = inlinePageScript(html);

  expect(script).toContain("click again to replace this conversation");
  expect(html).toContain("leaves\n          every repository file exactly as it is");
});

test("the page shows no raw JSON panel", () => {
  const html = ownerPageHtml("test-nonce");

  // The primary workflow is the conversation. A reader who wants a payload has the browser's own
  // network tools; a `<pre>` of every response is noise beside a streaming turn.
  expect(html).not.toContain("JSON.stringify(value, null, 2)");
  expect(html).not.toMatch(/id="[a-z-]+-raw"/u);
});

test("the page asks for no credential and stores none", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).not.toContain("password");
  expect(html).not.toContain("localStorage");
  expect(html).not.toContain("sessionStorage");
  expect(html).not.toContain("document.cookie");
  expect(html).not.toContain("CF_Authorization");
});

/** The delivered script's own label check, extracted and run rather than matched as text. */
function controlLabelFrom(script: string): (raw: string) => number | null {
  const found = /\n {2}function controlLabel\(raw\) \{[\s\S]*?\n {2}\}\n/u.exec(script);

  if (found === null) {
    throw new Error("the owner page carries no controlLabel function");
  }

  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the constructed function is the extracted source above, whose only added statement returns `controlLabel`.
  const made = new Function(`${found[0]}\nreturn controlLabel;`) as () => (
    raw: string,
  ) => number | null;

  return made();
}

test("a generation label names one whole generation or nothing", () => {
  const controlLabel = controlLabelFrom(inlinePageScript(ownerPageHtml("test-nonce")));

  // Number.parseInt("1.5") is 1, so a page that parsed the field would activate generation 1 for a
  // reader who typed something that names no generation at all.
  expect(controlLabel("2")).toBe(2);
  expect(controlLabel(" 3 ")).toBe(3);
  expect(controlLabel("0")).toBe(0);
  expect(controlLabel("1.5")).toBe(null);
  expect(controlLabel("-1")).toBe(null);
  expect(controlLabel("")).toBe(null);
  expect(controlLabel("two")).toBe(null);
});
