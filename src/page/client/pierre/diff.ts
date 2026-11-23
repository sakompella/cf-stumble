import {
  DiffHunksRenderer,
  hastToHtml,
  parsePatchFiles,
  registerCustomTheme,
  SVGSpriteSheet,
  wrapCoreCSS,
  wrapThemeCSS,
  type DiffHunksRendererOptions,
  type FileDiffMetadata,
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

async function fileView(fileDiff: FileDiffMetadata): Promise<RenderedDiff> {
  const renderer = new DiffHunksRenderer(OPTIONS);
  const result = await renderer.asyncRender(fileDiff);
  const header = result.headerElement === undefined ? "" : hastToHtml(result.headerElement);

  return {
    html: header + renderer.renderFullHTML(result),
    sheets: [styleSheet(wrapThemeCSS(result.themeStyles, result.baseThemeType ?? "system"))],
  };
}

export async function renderDiff(patch: string): Promise<RenderedDiff | undefined> {
  const files = parsePatchFiles(patch).flatMap(({ files: patchFiles }) => patchFiles);

  if (files.length === 0) {
    return undefined;
  }

  const views = await Promise.all(files.map(fileView));

  return {
    html: SVGSpriteSheet + views.map(({ html }) => html).join(""),
    sheets: [coreSheet, ...(views[0]?.sheets ?? [])],
  };
}
