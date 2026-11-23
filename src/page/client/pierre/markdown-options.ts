import { pierreDark, pierreLight } from "@pierre/highlights/themes";
import { createHighlightsPlugin } from "@pierre/words/highlights";
import type { CodeHighlighterPlugin, CodeOptions, HtmlOptions } from "@pierre/words/html";

const WEB_LINK = /^https?:\/\//u;

const TAG_BREAK = "\u2060";

const HTML_START = /<(?=[A-Za-z/!?])/gu;

export function markdownSource(text: string): string {
  return text.replaceAll(HTML_START, `<${TAG_BREAK}`);
}

export function withoutTagBreaks(text: string): string {
  return text.replaceAll(TAG_BREAK, "");
}

function plainCode(options: CodeOptions): CodeOptions {
  return { ...options, code: withoutTagBreaks(options.code) };
}

const highlights = createHighlightsPlugin({
  themes: { light: pierreLight, dark: pierreDark },
  defaultColor: "light-dark()",
});

const code: CodeHighlighterPlugin = {
  highlight: (options) => highlights.highlight(plainCode(options)),
  createSession: () => {
    const session = highlights.createSession?.();

    return {
      highlight: (options) => session?.highlight(plainCode(options)) ?? null,
      highlightLines: (options) => session?.highlightLines?.(plainCode(options)) ?? null,
      dispose: () => session?.dispose(),
    };
  },
};

export const MARKDOWN_OPTIONS: HtmlOptions = {
  plugins: { code },
  components: {
    a: (html) => html.replace("<a ", '<a target="_blank" rel="noreferrer noopener" '),
  },
  controls: false,
  lineNumbers: false,
  disallowedElements: ["img"],
  urlTransform: (url) => (WEB_LINK.test(url) ? url : null),
};
