import * as Option from "effect/Option";
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_CLASSES as CLASS } from "../element-ids.js";
import { Message } from "./message.js";
import { FollowTranscript } from "./mount.js";
import { DiffView, MarkdownView } from "./pierre-views.js";
import { boundedLines, looksLikeDiff, TranscriptEntry } from "./transcript.js";

function note(text: string, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("note")], [text]);
}

function toolOutput(
  output: string | undefined,
  patch: string | undefined,
  h: HtmlBuilder<Message>,
): Html {
  if (output === undefined) {
    return h.pre([h.Class(CLASS.toolOutput)], ["running…"]);
  }

  const bounded = boundedLines(output);
  const text = bounded.lines.join("\n");

  const shown = h.pre(
    [h.Class(CLASS.toolOutput)],
    bounded.isShortened ? [text, note("\n… shortened for display", h)] : [text],
  );

  const diffPatch = patch ?? (looksLikeDiff(output) ? text : undefined);

  if (diffPatch === undefined) {
    return shown;
  }

  const diff = DiffView.withMessage(h);

  return diff([diff.Patch(diffPatch)], [shown]);
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
  patch: string | undefined,
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
        [h.summary([], [summary]), toolOutput(output, patch, h)],
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
  isStreaming: boolean,
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  const markdown = MarkdownView.withMessage(h);

  const body =
    role === "assistant"
      ? markdown([h.Class("text markdown"), markdown.Source(text), markdown.Streaming(isStreaming)])
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

function unconfirmedRow(
  requestId: string,
  text: string,
  key: string,
  h: HtmlBuilder<Message>,
): Html {
  return entry(
    "user",
    "you · not confirmed",
    [
      h.pre([h.Class("text")], [text]),
      h.button([h.Type("button"), h.OnClick(Message.ClickedRetrySend({ requestId }))], ["Retry"]),
    ],
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
    Text: ({ role, who, text, isStreaming }) =>
      lazyRow(key, textRow, [role, who, text, isStreaming, key, h]),
    Tool: ({ summary, isFailed, maybeOutput, maybePatch }) =>
      lazyRow(key, toolRow, [
        summary,
        isFailed,
        Option.getOrUndefined(maybeOutput),
        Option.getOrUndefined(maybePatch),
        key,
        h,
      ]),
    Unconfirmed: ({ requestId, text }) => lazyRow(key, unconfirmedRow, [requestId, text, key, h]),
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
