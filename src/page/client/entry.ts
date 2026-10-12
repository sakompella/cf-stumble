import { Runtime } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Model } from "./model.js";
import { subscriptions } from "./turn.js";
import { init, update } from "./update.js";
import { view } from "./view.js";

/**
 * Shown if the program stops. Foldkit's own crash view reloads through an inline `onclick`, which
 * the page's Content Security Policy refuses, so this one offers a plain link to the page instead.
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
 * The owner page's one runtime side effect: start the Foldkit element in the container the Worker
 * served. The view renders a root with the same id, so the container is replaced in place.
 * `makeElement` rather than `makeApplication`, because the Worker owns the document's head.
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
