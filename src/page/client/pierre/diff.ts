import {
  createHastElement,
  createTextNodeElement,
  DiffHunksRenderer,
  hastToHtml,
  parsePatchFiles,
  registerCustomTheme,
  SVGSpriteSheet,
  wrapCoreCSS,
  wrapThemeCSS,
  type DiffHunksRendererOptions,
  type FileDiffMetadata,
  type ParsedPatch,
} from "@pierre/diffs";
import { pierreDark, pierreLight } from "@pierre/highlights/themes";
import { styleSheet } from "./style-sheet.js";

export type RenderedDiff = Readonly<{ html: string; sheets: readonly CSSStyleSheet[] }>;

registerCustomTheme("stumble-light", () => Promise.resolve(pierreLight), "zed");

registerCustomTheme("stumble-dark", () => Promise.resolve(pierreDark), "zed");

const OPTIONS: DiffHunksRendererOptions = {
  theme: { light: "stumble-light", dark: "stumble-dark" },
  preferredHighlighter: "highlights",
  lineDiffType: "word",
  diffStyle: "unified",
  overflow: "wrap",
};

const coreSheet = styleSheet(wrapCoreCSS());

const textSheet = styleSheet(
  "[data-patch-text] { font: 0.8rem ui-monospace, monospace; margin: 0 0 0.4rem; white-space: pre-wrap; word-break: break-word; }",
);

async function fileView(fileDiff: FileDiffMetadata): Promise<RenderedDiff> {
  const renderer = new DiffHunksRenderer(OPTIONS);
  const result = await renderer.asyncRender(fileDiff);
  const header = result.headerElement === undefined ? "" : hastToHtml(result.headerElement);

  return {
    html: header + renderer.renderFullHTML(result),
    sheets: [styleSheet(wrapThemeCSS(result.themeStyles, result.baseThemeType ?? "system"))],
  };
}

function patchText(text: string | undefined): string {
  return text === undefined || text.trim() === ""
    ? ""
    : hastToHtml(
        createHastElement({
          tagName: "pre",
          properties: { "data-patch-text": "" },
          children: [createTextNodeElement(text.trimEnd())],
        }),
      );
}

async function patchView({ patchMetadata, files }: ParsedPatch): Promise<RenderedDiff> {
  const views = await Promise.all(files.map(fileView));

  return {
    html: patchText(patchMetadata) + views.map(({ html }) => html).join(""),
    sheets: views[0]?.sheets ?? [],
  };
}

export async function renderDiff(patch: string): Promise<RenderedDiff | undefined> {
  const patches = parsePatchFiles(patch);

  if (patches.every(({ files }) => files.length === 0)) {
    return undefined;
  }

  const views = await Promise.all(patches.map(patchView));

  return {
    html: SVGSpriteSheet + views.map(({ html }) => html).join(""),
    sheets: [
      coreSheet,
      textSheet,
      ...(views.find(({ sheets }) => sheets.length > 0)?.sheets ?? []),
    ],
  };
}
