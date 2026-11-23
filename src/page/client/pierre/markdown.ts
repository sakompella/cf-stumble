import { createDomRenderer } from "@pierre/words/html";
import wordsStyles from "@pierre/words/styles.css";
import { MARKDOWN_OPTIONS, markdownSource, withoutTagBreaks } from "./markdown-options.js";
import { styleSheet } from "./style-sheet.js";

export type MarkdownView = Readonly<{ update: (source: string, isStreaming: boolean) => void }>;

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet(wordsStyles)];

function removeTagBreaks(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const plain = withoutTagBreaks(text);

    if (plain !== text) {
      node.textContent = plain;
    }
  }
}

export function mountMarkdown(root: HTMLElement): MarkdownView {
  const renderer = createDomRenderer(root, MARKDOWN_OPTIONS);

  return {
    update: (source, isStreaming) => {
      renderer.update(markdownSource(source), isStreaming, isStreaming);
      removeTagBreaks(root);
    },
  };
}
