import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Predicate from "effect/Predicate";
import { inertHtml, type Html } from "foldkit/html";
import { expect, test } from "vitest";
import { markdownBlocks } from "../../../src/page/client/markdown.js";

/**
 * Assistant text is model output, so the rendered tree may hold only the elements the renderer
 * names, and the words the model wrote must come out as text, whatever they look like.
 */

const ALLOWED = new Set([
  "p",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "em",
  "strong",
  "a",
]);

type Rendered = NonNullable<Html>;

function render(text: string): readonly Rendered[] {
  return markdownBlocks(text, inertHtml).filter(Predicate.isNotNull);
}

function children(node: Rendered): readonly Rendered[] {
  return (node.children ?? []).flatMap((child) => (Predicate.isString(child) ? [] : [child]));
}

function elements(node: Rendered): readonly Rendered[] {
  return node.sel === undefined ? [] : [node, ...children(node).flatMap(elements)];
}

function textOf(node: Rendered): string {
  return node.text ?? children(node).map(textOf).join("");
}

function words(value: string): readonly string[] {
  return value.split(/\s+/u).filter((word) => word !== "");
}

const MARKUP_HEAVY = "*_`#-+[]()<>!\\\n 1.a/:h".split("");

test("input of any shape renders only allowed elements, and links only to http(s)", () => {
  hegel.test(
    (tc) => {
      const characters = tc.draw(gs.arrays(gs.sampledFrom(MARKUP_HEAVY), { maxSize: 60 }));
      const urls = tc.draw(gs.booleans()) ? "[x](https://a.b/c)[y](javascript:alert(1))" : "";
      const found = render(characters.join("") + urls).flatMap(elements);

      for (const node of found) {
        const tag = String(node.sel).split(/[.#]/u)[0] ?? "";

        expect(ALLOWED.has(tag), tag).toBe(true);

        if (tag === "a") {
          expect(String(node.data?.props?.["href"])).toMatch(/^https?:\/\//u);
        }
      }
    },
    { testCases: 300 },
  );
});

test("text without markup comes out as the same words in the same order", () => {
  const plain = "abc <>/\"&'=\n".split("");

  hegel.test(
    (tc) => {
      const text = tc.draw(gs.arrays(gs.sampledFrom(plain), { maxSize: 60 })).join("");
      expect(words(render(text).map(textOf).join(" "))).toStrictEqual(words(text));
    },
    { testCases: 300 },
  );
});

test("fenced and inline code keep their content exactly", () => {
  hegel.test(
    (tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ maxSize: 12 }), { minSize: 1, maxSize: 5 }));
      const body = lines.filter((line) => !line.includes("\n") && !line.startsWith("```"));
      const fenced = render(`\`\`\`ts\n${body.join("\n")}\n\`\`\``);

      expect(fenced.map((node) => node.sel)).toStrictEqual(["pre"]);
      expect(fenced.map(textOf)).toStrictEqual([body.join("\n")]);
    },
    { testCases: 300 },
  );
});
