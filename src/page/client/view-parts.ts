import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./message.js";

export function valueRow(label: string, id: string, value: string, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row")],
    [h.span([h.Class("field-label")], [label]), h.span([h.Class("value"), h.Id(id)], [value])],
  );
}

export function statusText(id: string, value: string, h: HtmlBuilder<Message>): Html {
  return h.span([h.Class("status"), h.Id(id), h.Role("status"), h.AriaLive("polite")], [value]);
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
