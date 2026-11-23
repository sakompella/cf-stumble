import * as Schema from "effect/Schema";
import { CustomElement } from "foldkit";

export const MarkdownView = CustomElement.define({
  tag: "stumble-markdown",
  properties: { source: Schema.String, streaming: Schema.Boolean },
  events: {},
});

export const DiffView = CustomElement.define({
  tag: "stumble-diff",
  properties: { patch: Schema.String },
  events: {},
});
