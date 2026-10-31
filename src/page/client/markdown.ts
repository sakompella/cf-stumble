import type { Html, HtmlBuilder } from "foldkit/html";

type Child = Html | string;

const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)(.+?)\*\*|\*(?=[^\s*])([^*\n]+?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu;

const FENCE = /^```/u;

const HEADING = /^(#{1,6})\s+(.*)$/u;

const ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/u;

function inline<Message>(text: string, h: HtmlBuilder<Message>): readonly Child[] {
  const children: Child[] = [];
  let consumed = 0;

  for (const found of text.matchAll(INLINE)) {
    const [whole, code, strong, emphasis, label, href] = found;
    const before = text.slice(consumed, found.index);

    const node =
      code === undefined
        ? strong === undefined
          ? emphasis === undefined
            ? h.a(
                [h.Href(href ?? ""), h.Rel("noreferrer noopener"), h.Target("_blank")],
                inline(label ?? "", h),
              )
            : h.em([], inline(emphasis, h))
          : h.strong([], inline(strong, h))
        : h.code([], [code]);

    children.push(...(before === "" ? [] : [before]), node);
    consumed = found.index + whole.length;
  }

  const rest = text.slice(consumed);

  return rest === "" ? children : [...children, rest];
}

function startsBlock(line: string): boolean {
  return line.trim() === "" || FENCE.test(line) || HEADING.test(line) || ITEM.test(line);
}

export function markdownBlocks<Message>(text: string, h: HtmlBuilder<Message>): readonly Html[] {
  const lines = text.split("\n");
  const blocks: Html[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const heading = HEADING.exec(line);
    const item = ITEM.exec(line);

    if (FENCE.test(line)) {
      const body: string[] = [];

      for (index += 1; index < lines.length && !FENCE.test(lines[index] ?? ""); index += 1) {
        body.push(lines[index] ?? "");
      }

      blocks.push(h.pre([], [h.code([], [body.join("\n")])]));
      index += 1;
    } else if (heading !== null) {
      const level = Math.min((heading[1] ?? "").length + 2, 6);
      const make = { 3: h.h3, 4: h.h4, 5: h.h5, 6: h.h6 }[level] ?? h.h6;

      blocks.push(make([], inline(heading[2] ?? "", h)));
      index += 1;
    } else if (item !== null) {
      const ordered = item[1] === undefined;
      const items: Html[] = [];

      for (; index < lines.length; index += 1) {
        const next = ITEM.exec(lines[index] ?? "");

        if (next === null || (next[1] === undefined) !== ordered) {
          break;
        }

        items.push(h.li([], inline(next[2] ?? "", h)));
      }

      blocks.push(ordered ? h.ol([], items) : h.ul([], items));
    } else if (line.trim() === "") {
      index += 1;
    } else {
      const start = index;

      while (index < lines.length && (index === start || !startsBlock(lines[index] ?? ""))) {
        index += 1;
      }

      blocks.push(h.p([], inline(lines.slice(start, index).join("\n"), h)));
    }
  }

  return blocks;
}
