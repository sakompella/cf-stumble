import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { createHtmlRenderer } from "@pierre/words/html";
import { expect, test } from "vitest";
import { MARKDOWN_OPTIONS } from "../../../src/page/client/pierre/markdown-options.js";

const ELEMENTS = new Set(
  "p a em strong del code pre span div br hr blockquote ul ol li input h1 h2 h3 h4 h5 h6 table thead tbody tr th td sup section".split(
    " ",
  ),
);

const ATTRIBUTES = new Set(
  "data-markdown data-markdown-incomplete data-language data-meta dir class href target rel id type disabled readonly checked start style aria-label aria-hidden data-footnote-ref data-footnote-backref data-footnote-backref-idx data-footnotes".split(
    " ",
  ),
);

const TAG = /<\/?([a-z][a-z0-9]*)((?:\s+[a-z][a-z-]*(?:="[^"<>]*")?)*)\s*>/gu;

const ATTRIBUTE = /\s([a-z][a-z-]*)(?:="([^"]*)")?/gu;

const STYLE = /^(?:color:[^;"]+;|text-align:(?:left|center|right))$/u;

const FRAGMENTS = [
  ..."*_`#-+[]()<>!\\\n 1.a/:h|~&=\"'".split(""),
  "```",
  "~~~",
  "\n\n",
  "- [ ] ",
  "|---|",
  "[^1]",
  "    ",
  "ts\n",
  "<script>",
  "</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">',
  " onclick=",
  "style=",
  "javascript:alert(1)",
  "data:text/html,x",
  "https://a.b/c",
  "www.x.com",
];

function render(text: string, isStreaming: boolean): string {
  const renderer = createHtmlRenderer(MARKDOWN_OPTIONS);
  const { html } = renderer.render(text, isStreaming);

  renderer.dispose();

  return html;
}

function attributeProblems(attributes: string): readonly string[] {
  return [...attributes.matchAll(ATTRIBUTE)].flatMap(([, name = "", value = ""]) => [
    ...(ATTRIBUTES.has(name) ? [] : [`attribute ${name}`]),
    ...(name === "href" && !/^https?:\/\//u.test(value) ? [`href ${value}`] : []),
    ...(name === "style" && !STYLE.test(value) ? [`style ${value}`] : []),
    ...(name === "type" && value !== "checkbox" ? [`type ${value}`] : []),
  ]);
}

function problems(html: string): readonly string[] {
  const tags = [...html.matchAll(TAG)];
  const outsideTags = html.replaceAll(TAG, "");

  return [
    ...tags.flatMap(([, name = "", attributes = ""]) => [
      ...(ELEMENTS.has(name) ? [] : [`element ${name}`]),
      ...attributeProblems(attributes),
    ]),
    ...(/[<>]/u.test(outsideTags) ? [`raw markup in ${outsideTags}`] : []),
  ];
}

const CODE_HEADER = /<div data-markdown="code-header">.*?<\/div>/gu;

function plainWords(html: string): readonly string[] {
  return html
    .replaceAll(CODE_HEADER, " ")
    .replaceAll(TAG, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .split(/\s+/u)
    .filter((word) => word !== "");
}

test("input of any shape renders only allowed elements and attributes, and links only to http(s)", () => {
  hegel.test(
    (tc) => {
      const text = tc.draw(gs.arrays(gs.sampledFrom(FRAGMENTS), { maxSize: 60 })).join("");
      const html = render(text, tc.draw(gs.booleans()));

      expect(problems(html), html).toStrictEqual([]);
    },
    { testCases: 300 },
  );
});

test("raw HTML, javascript: links and event attributes never reach the output", () => {
  const html = render(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) <a href="javascript:alert(2)" onclick="alert(3)">y</a>',
    false,
  );

  expect(problems(html)).toStrictEqual([]);
  expect(html).not.toMatch(/<script|<img|onerror|onclick|javascript:/u);
});

test("text without markup comes out as the same words in the same order", () => {
  const plain = "abc /\"&'\n".split("");

  hegel.test(
    (tc) => {
      const text = tc.draw(gs.arrays(gs.sampledFrom(plain), { maxSize: 60 })).join("");

      expect(plainWords(render(text, false))).toStrictEqual(
        text.split(/\s+/u).filter((word) => word !== ""),
      );
    },
    { testCases: 300 },
  );
});
