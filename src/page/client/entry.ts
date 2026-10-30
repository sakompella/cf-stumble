import { Runtime } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Model } from "./model.js";
import { subscriptions } from "./events-stream.js";
import { init, update } from "./update.js";
import { view } from "./view.js";

/**
 * Foldkit's own crash view reloads through an inline `onclick`, which the page's Content Security
 * Policy refuses, so this one offers a plain link instead.
 */
function crashView({ error }: Readonly<{ error: Error }>, h: HtmlBuilder<never>): Html {
  return h.main(
    [h.Id(ID.root)],
    [
      h.h1([], ["cf-stumble"]),
      h.p([h.Id(ID.pageError)], [`This page stopped: ${error.message}`]),
      h.p([], [h.a([h.Href("/")], ["Reload the page"])]),
    ],
  );
}

/**
 * `makeElement` rather than `makeApplication`, because the Worker owns the document's head. The view
 * renders a root with the same id, so the container is replaced in place.
 */
Runtime.run(
  Runtime.makeElement({
    Model,
    init,
    update,
    view,
    subscriptions,
    crash: { view: crashView },
    container: document.querySelector<HTMLElement>(`#${ID.root}`),
  }),
);
