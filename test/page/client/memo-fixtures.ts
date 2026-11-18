import type { HtmlBuilder } from "foldkit/html";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import type { view } from "../../../src/page/client/view.js";
import { entryItem, received, running, streaming, viewing } from "./views.js";

const listed = update(
  init().model,
  Message.SucceededFetchProjects({
    projects: [{ id: "repo", displayName: "repo", isHarness: false, location: "/workspace/repo" }],
  }),
).model;

const history = [
  entryItem(
    1,
    { role: "user", content: "show the diff" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is **the** diff." },
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "git diff" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "t",
      toolName: "bash",
      content: [{ type: "text", text: "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new" }],
      isError: false,
    },
  ),
];

export const withHistory = update(listed, received(listed, viewing({ items: history }))).model;

export function streamed(text: string): Model {
  return update(
    withHistory,
    received(withHistory, running({ items: history, maybePartial: streaming(text) })),
  ).model;
}

export function renderingEach(
  first: Model,
  second: Model,
  render: (model: Model, h: HtmlBuilder<Message>) => ReturnType<typeof view>,
) {
  let renders = 0;

  return (_: null, h: HtmlBuilder<Message>) => {
    renders += 1;

    return render(renders === 1 ? first : second, h);
  };
}
