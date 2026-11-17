import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";

const MAX_CHARACTERS = 160;

const MAX_VALUE_CHARACTERS = 60;

function shortened(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();

  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function shownValue(value: Schema.Json): string | undefined {
  return Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? shortened(String(value), MAX_VALUE_CHARACTERS)
    : undefined;
}

export function toolSummaryText(
  toolName: string,
  args: Readonly<Record<string, Schema.Json>>,
): string {
  const command = args["command"];

  if (Predicate.isString(command)) return shortened(`${toolName} $ ${command}`, MAX_CHARACTERS);

  const fields = Object.entries(args).flatMap(([key, value]) => {
    const shown = shownValue(value);

    return shown === undefined ? [] : [`${key}: ${shown}`];
  });

  return fields.length === 0
    ? toolName
    : shortened(`${toolName} ${fields.join(", ")}`, MAX_CHARACTERS);
}
