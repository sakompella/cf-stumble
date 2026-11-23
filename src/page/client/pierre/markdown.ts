import { createDomRenderer } from "@pierre/words/html";
import wordsStyles from "@pierre/words/styles.css";
import { MARKDOWN_OPTIONS } from "./markdown-options.js";
import { styleSheet } from "./style-sheet.js";

export type MarkdownView = Readonly<{ update: (source: string, isStreaming: boolean) => void }>;

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet(wordsStyles)];

export function mountMarkdown(root: HTMLElement): MarkdownView {
  const renderer = createDomRenderer(root, MARKDOWN_OPTIONS);

  return {
    update: (source, isStreaming) => {
      renderer.update(source, isStreaming, isStreaming);
    },
  };
}
