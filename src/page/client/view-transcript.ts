import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_CLASSES as CLASS } from "../element-ids.js";
import type { Message } from "./message.js";
import { FollowTranscript } from "./mount.js";
import {
  boundedLines,
  diffLineKind,
  looksLikeDiff,
  TranscriptEntry,
  type ToolEntry,
} from "./transcript.js";

/**
 * How the transcript renders. Two bounds keep a long turn readable and the page responsive: a tool
 * result is collapsed by default, and at most 20,000 characters and 400 lines of any output are
 * laid out. A result that looks like a unified diff renders line by line with its adds and removes
 * marked. Every value is a text child, never markup.
 */

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

function toolView(tool: ToolEntry, h: HtmlBuilder<Message>): Html {
  const output = Option.match(tool.maybeOutput, {
    onNone: () => ["running…"],
    onSome: (result) => [
      ...outputChildren(result.content, h),
      ...(result.isServerTruncated ? [note("\n… the server truncated this output", h)] : []),
    ],
  });

  return h.details(
    [
      h.Class(tool.isFailed ? `${CLASS.toolCall} failed` : CLASS.toolCall),
      // The reader opens and closes a disclosure, so the browser owns its open state. A failure
      // opens it once, through the attribute, and the reader may close it again.
      ...(tool.isFailed ? [h.Attribute("open", "")] : []),
    ],
    [h.summary([], [tool.summary]), h.pre([h.Class(CLASS.toolOutput)], output)],
  );
}

function entryView(item: TranscriptEntry, index: number, h: HtmlBuilder<Message>): Html {
  const key = String(index);
  const pre = (children: readonly (Html | string)[]) => h.pre([h.Class("text")], children);

  return TranscriptEntry.match<Html>(item, {
    Text: ({ role, who, text }) => entry(role, who, [pre([text])], key, h),
    Tool: (tool) => entry("tool", "tool call", [toolView(tool, h)], key, h),
    Diff: ({ content, isTruncated }) =>
      entry(
        "diff",
        "diff",
        [
          pre([
            ...outputChildren(content, h),
            ...(isTruncated ? [note("\n… the harness truncated this diff", h)] : []),
          ]),
        ],
        key,
        h,
      ),
    DiffUnavailable: ({ detail }) => entry("diff unavailable", "diff", [pre([detail])], key, h),
    Terminal: ({ wording, isProblem }) =>
      entry(isProblem ? "terminal problem" : "terminal", "turn", [pre([wording])], key, h),
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
