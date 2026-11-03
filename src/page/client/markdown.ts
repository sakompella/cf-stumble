import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";

type Child = Html | string;

const INLINE = /`([^`\n]+)`|\*\*(?=\S)(.+?)\*\*|\*(?=[^\s*])([^*\n]+?)\*|\[/gu;

const LINK_TARGET_START = /\]\(https?:\/\//uy;

const FENCE = /^`{3,}/u;

const FENCE_CLOSE = /^(`{3,})\s*$/u;

const HEADING = /^(#{1,6})\s+(.*)$/u;

const ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/u;

type Link = Readonly<{ label: string; href: string; end: number }>;

function nextStop(stops: RegExp, text: string): (from: number) => number {
  let stop = -1;

  return (from) => {
    if (stop < from) {
      stops.lastIndex = from;
      stop = stops.exec(text)?.index ?? text.length;
    }

    return stop;
  };
}

function linkRecognizer(text: string): (open: number) => Option.Option<Link> {
  const labelEndFrom = nextStop(/[\]\n]/gu, text);
  const hrefEndFrom = nextStop(/[\s)]/gu, text);

  return (open) => {
    const labelEnd = labelEndFrom(open + 1);

    LINK_TARGET_START.lastIndex = labelEnd;
    const targetStart = LINK_TARGET_START.exec(text);

    if (labelEnd === open + 1 || targetStart === null) {
      return Option.none();
    }

    const hrefStart = labelEnd + targetStart[0].length;
    const hrefEnd = hrefEndFrom(hrefStart);

    return hrefEnd > hrefStart && text[hrefEnd] === ")"
      ? Option.some({
          label: text.slice(open + 1, labelEnd),
          href: text.slice(labelEnd + 2, hrefEnd),
          end: hrefEnd + 1,
        })
      : Option.none();
  };
}

function inline<Message>(text: string, h: HtmlBuilder<Message>): readonly Child[] {
  const children: Child[] = [];
  const pattern = new RegExp(INLINE, "gu");
  const linkAt = linkRecognizer(text);
  let consumed = 0;

  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    const [whole, code, strong, emphasis] = found;
    const maybeLink = whole === "[" ? linkAt(found.index) : Option.none();

    if (whole === "[" && Option.isNone(maybeLink)) {
      continue;
    }

    const node = Option.match(maybeLink, {
      onSome: ({ label, href }) =>
        h.a([h.Href(href), h.Rel("noreferrer noopener"), h.Target("_blank")], inline(label, h)),
      onNone: () =>
        code === undefined
          ? strong === undefined
            ? h.em([], inline(emphasis ?? "", h))
            : h.strong([], inline(strong, h))
          : h.code([], [code]),
    });

    const before = text.slice(consumed, found.index);

    children.push(...(before === "" ? [] : [before]), node);
    consumed = Option.match(maybeLink, {
      onSome: ({ end }) => end,
      onNone: () => found.index + whole.length,
    });
    pattern.lastIndex = consumed;
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

    const fence = FENCE.exec(line)?.[0];

    if (fence !== undefined) {
      const closes = (next: string) => (FENCE_CLOSE.exec(next)?.[1] ?? "").length >= fence.length;
      const body: string[] = [];

      for (index += 1; index < lines.length && !closes(lines[index] ?? ""); index += 1) {
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
