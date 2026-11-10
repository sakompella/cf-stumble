import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import type { Model } from "../../../src/page/client/model.js";
import { update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";
import { followResolved } from "./views.js";

export type Rendered = NonNullable<ReturnType<typeof view>>;

export function htmlOf(model: Model): Rendered {
  let html: Rendered | undefined;

  Scene.scene(
    { update, view },
    Scene.given(model),
    Scene.tap((simulation) => {
      html = simulation.html;
    }),
    followResolved,
  );

  if (html === undefined) throw new Error("the page rendered nothing");

  return html;
}

export function findById(node: Rendered | string, id: string): Rendered | undefined {
  if (Predicate.isString(node)) return undefined;

  return node.data?.props?.["id"] === id
    ? node
    : (node.children ?? []).map((child) => findById(child, id)).find(Predicate.isNotUndefined);
}

export function textOf(node: Rendered | string): string {
  return Predicate.isString(node)
    ? node
    : (node.text ?? "") + (node.children ?? []).map(textOf).join("");
}
