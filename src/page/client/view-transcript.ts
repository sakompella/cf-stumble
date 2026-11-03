import * as Option from "effect/Option";
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_CLASSES as CLASS } from "../element-ids.js";
import { Message } from "./message.js";
import { markdownBlocks } from "./markdown.js";
import { FollowTranscript } from "./mount.js";
import { boundedLines, diffLineKind, looksLikeDiff, TranscriptEntry } from "./transcript.js";

function note(text: string, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("note")], [text]);
}

function outputChildren(content: string, h: HtmlBuilder<Message>): readonly (Html | string)[] {
  const bounded = boundedLines(content);

  const body = looksLikeDiff(content)
    ? bounded.lines.map((line) => {
        const kind = diffLineKind(line);
        const className = kind === "plain" ? CLASS.diffLine : `${CLASS.diffLine} ${kind}`;

        return h.span([h.Class(className)], [`${line}\n`]);
      })
    : [bounded.lines.join("\n")];

  return bounded.isShortened ? [...body, note("\n… shortened for display", h)] : body;
}

function entry(
  role: string,
  who: string,
  children: readonly (Html | string)[],
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  return h.li(
    [h.Key(key), h.Class(`${CLASS.message} ${role}`)],
    [h.span([h.Class("who")], [who]), ...children],
  );
}

function toolRow(
  summary: string,
  isFailed: boolean,
  output: string | undefined,
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  return entry(
    "tool",
    "tool call",
    [
      h.details(
        [
          h.Class(isFailed ? `${CLASS.toolCall} failed` : CLASS.toolCall),
          ...(isFailed ? [h.Attribute("open", "")] : []),
        ],
        [
          h.summary([], [summary]),
          h.pre(
            [h.Class(CLASS.toolOutput)],
            output === undefined ? ["running…"] : outputChildren(output, h),
          ),
        ],
      ),
    ],
    key,
    h,
  );
}

function textRow(
  role: string,
  who: string,
  text: string,
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  const body =
    role === "assistant"
      ? h.div([h.Class("text markdown")], markdownBlocks(text, h))
      : h.pre([h.Class("text")], [text]);

  return entry(role, who, [body], key, h);
}

function terminalRow(
  wording: string,
  isProblem: boolean,
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  return entry(
    isProblem ? "terminal problem" : "terminal",
    "run",
    [h.pre([h.Class("text")], [wording])],
    key,
    h,
  );
}

function loadRow(label: string, onClick: Message, key: string, h: HtmlBuilder<Message>): Html {
  return h.li(
    [h.Key(key), h.Class(`${CLASS.message} load`)],
    [h.button([h.Type("button"), h.OnClick(onClick)], [label])],
  );
}

const lazyRow = createKeyedLazy();

function entryView(item: TranscriptEntry, index: number, h: HtmlBuilder<Message>): Html {
  const key = String(index);

  return TranscriptEntry.match<Html>(item, {
    Text: ({ role, who, text }) => lazyRow(key, textRow, [role, who, text, key, h]),
    Tool: ({ summary, isFailed, maybeOutput }) =>
      lazyRow(key, toolRow, [summary, isFailed, Option.getOrUndefined(maybeOutput), key, h]),
    Terminal: ({ wording, isProblem }) => lazyRow(key, terminalRow, [wording, isProblem, key, h]),
    Earlier: () => loadRow("Load earlier messages", Message.ClickedLoadEarlier(), key, h),
    Gap: ({ itemIndex }) =>
      loadRow("Load missing messages", Message.ClickedFillGap({ itemIndex }), key, h),
  });
}

export function transcriptView(
  transcript: readonly TranscriptEntry[],
  listId: string,
  h: HtmlBuilder<Message>,
): Html {
  return h.ol(
    [h.Id(listId), h.Class("messages"), h.OnMount(FollowTranscript())],
    transcript.map((item, index) => entryView(item, index, h)),
  );
}
