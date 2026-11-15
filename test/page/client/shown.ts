import * as Predicate from "effect/Predicate";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import type { Model } from "../../../src/page/client/model.js";
import { findById, htmlOf, textOf, type Rendered } from "./rendered.js";

export type Row = Readonly<{ who: string; text: string }>;

export function shownText(model: Model, id: string): string {
  return textOf(findById(htmlOf(model), id) ?? "");
}

export function fieldValue(model: Model, id: string): string {
  const value: unknown = findById(htmlOf(model), id)?.data?.props?.["value"];

  return Predicate.isString(value) ? value : "";
}

export function disabledShown(model: Model, id: string): boolean {
  return findById(htmlOf(model), id)?.data?.props?.["disabled"] === true;
}

export const promptShown = (model: Model): string => fieldValue(model, ID.promptInput);

export const freshShown = (model: Model): string => shownText(model, ID.freshThreadStatus);

export const streamShown = (model: Model): string => shownText(model, ID.conversationState);

export const runShown = (model: Model): string => shownText(model, ID.turnState);

function rowOf(node: Rendered | string): Row {
  const [who = "", body = ""] = Predicate.isString(node) ? [] : (node.children ?? []);

  return { who: textOf(who), text: textOf(body) };
}

export function rowsShown(model: Model): readonly Row[] {
  return (findById(htmlOf(model), ID.messageList)?.children ?? []).map(rowOf);
}

export function whoShown(model: Model): readonly string[] {
  return rowsShown(model).map((row) => row.who);
}
