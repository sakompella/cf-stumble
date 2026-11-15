import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled, type SentRequest } from "./requests.js";
import { shownText } from "./shown.js";

const STATUS = Message.SucceededFetchStatus({
  reading: { maybeActive: Option.none(), epoch: 3, maybeMainAhead: Option.none() },
});

const answered = (request: SentRequest) =>
  Promise.resolve(
    Response.json(
      request.path === "/api/generations/activate"
        ? { ok: true, outcome: { effect: "rolled forward" } }
        : { activeGeneration: { generation: null, epoch: 4 }, mainAhead: null },
    ),
  );

function activateClicked(value: string) {
  const page = [Message.UpdatedControlLabelInput({ kind: "activate", value }), STATUS].reduce(
    (model: Model, message) => update(model, message).model,
    init().model,
  );

  return settled(update(page, Message.ClickedControl({ kind: "activate" })), answered);
}

const SPACES = gs.text({ alphabet: " \t", maxSize: 3 });

const DIGITS = gs.text({ alphabet: "0123456789", minSize: 1, maxSize: 6 });

const NOT_A_DIGIT = gs.oneOf(
  gs.sampledFrom(["+", "-", "e", "E", "x", "."]),
  gs.characters({ excludeCategories: ["Nd", "Zs", "Zl", "Zp", "Cc", "Cf"] }),
);

test("a whole number typed as the label, with zeros or spaces around it, posts that generation for activation", () =>
  hegel.testAsync(async (tc) => {
    const label = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));
    const zeros = "0".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 3 })));
    const typed = `${tc.draw(SPACES)}${zeros}${label}${tc.draw(SPACES)}`;

    const done = await activateClicked(typed);

    expect(done.sent[0]).toEqual({
      method: "POST",
      path: "/api/generations/activate",
      body: { observedEpoch: 3, label },
    });
  }));

function withNonDigit(tc: hegel.TestCase): string {
  const digits = tc.draw(DIGITS);
  const other = tc.draw(NOT_A_DIGIT);
  const where = tc.draw(gs.sampledFrom(["before", "inside", "after"]));

  if (where === "before") return `${other}${digits}`;

  return where === "after" ? `${digits}${other}` : `${digits}${other}${tc.draw(DIGITS)}`;
}

const REFUSALS = ["non-digit", "too large", "empty", "blank", "letters"] as const;

function refusedLabel(tc: hegel.TestCase): string {
  const which = tc.draw(gs.sampledFrom(REFUSALS));

  if (which === "non-digit") return withNonDigit(tc);

  if (which === "too large") {
    return String(
      tc.draw(
        gs.bigIntegers({ minValue: BigInt(Number.MAX_SAFE_INTEGER) + 1n, maxValue: 10n ** 30n }),
      ),
    );
  }

  if (which === "empty") return "";

  if (which === "blank") return tc.draw(gs.text({ alphabet: " \t", minSize: 1, maxSize: 3 }));

  return tc.draw(gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz", minSize: 1, maxSize: 8 }));
}

test("a label that is not one whole generation posts nothing and the page says why", () =>
  hegel.testAsync(
    async (tc) => {
      const done = await activateClicked(refusedLabel(tc));

      expect(done.sent).toEqual([]);
      expect(shownText(done.model, ID.activateStatus)).toBe("enter a generation label");
    },
    { testCases: 300 },
  ));
