import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./message.js";

/**
 * The two shapes every panel on this page is built from: a labelled value a reader observes, and a
 * labelled control row. The element with `id` holds only the value a test must read.
 */
export function valueRow(label: string, id: string, value: string, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row")],
    [h.span([h.Class("field-label")], [label]), h.span([h.Class("value"), h.Id(id)], [value])],
  );
}

/**
 * A value row whose value a screen reader announces when it changes, once the reader is idle. Use
 * it only for a short sentence that changes a few times, never for a stream.
 */
export function statusRow(label: string, id: string, value: string, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row")],
    [
      h.span([h.Class("field-label")], [label]),
      h.span([h.Class("value"), h.Id(id), h.Role("status"), h.AriaLive("polite")], [value]),
    ],
  );
}

export type ControlRow = Readonly<{
  label: string;
  inputId: string;
  isNumber: boolean;
  value: string;
  onInput: (value: string) => Message;
  buttonId: string;
  buttonText: string;
  onClick: Message;
}>;

/** A labelled single-line input followed by the button that acts on it. */
export function controlRow(row: ControlRow, h: HtmlBuilder<Message>): Html {
  const inputAttributes = row.isNumber
    ? [h.Type("number"), h.Min("0"), h.Step("1")]
    : [h.Type("text"), h.Autocomplete("off"), h.Spellcheck(false)];

  return h.div(
    [h.Class("row")],
    [
      h.label([h.Class("field-label"), h.For(row.inputId)], [row.label]),
      h.input([h.Id(row.inputId), ...inputAttributes, h.Value(row.value), h.OnInput(row.onInput)]),
      h.button([h.Id(row.buttonId), h.Type("button"), h.OnClick(row.onClick)], [row.buttonText]),
    ],
  );
}
