import { pierreDark, pierreLight } from "@pierre/highlights/themes";
import { createHighlightsPlugin } from "@pierre/words/highlights";
import type { HtmlOptions } from "@pierre/words/html";

const WEB_LINK = /^https?:\/\//u;

export const MARKDOWN_OPTIONS: HtmlOptions = {
  plugins: {
    code: createHighlightsPlugin({
      themes: { light: pierreLight, dark: pierreDark },
      defaultColor: "light-dark()",
    }),
  },
  components: {
    a: (html) => html.replace("<a ", '<a target="_blank" rel="noreferrer noopener" '),
  },
  controls: false,
  lineNumbers: false,
  disallowedElements: ["img"],
  urlTransform: (url) => (WEB_LINK.test(url) ? url : null),
};
