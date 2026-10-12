import assert from "node:assert/strict";
import { describe, it } from "node:test";
import foldkit from "@foldkit/oxlint-plugin";
import { RuleTester } from "oxlint/plugins-dev";
import config from "../oxlint.config.ts";

/**
 * Foldkit's oxlint plugin checks the owner page. Every rule the pinned plugin ships must be decided
 * in the page override, so an upgrade cannot add one nobody read, and the enforced rules must
 * accept the page's idioms: `Message.match`, callable constructors, and `Option.map` with a named
 * callback.
 */

const PREFIX = "foldkit/";

/** The page override's Foldkit rules and their settings. */
const pageRules = new Map(
  (config.overrides ?? []).flatMap((override) =>
    override.files.includes("src/page/client/**")
      ? Object.entries(override.rules ?? {}).filter(([name]) => name.startsWith(PREFIX))
      : [],
  ),
);

const shippedRules = new Map(
  Object.entries(foldkit.rules).map(([name, rule]) => [`${PREFIX}${name}`, rule] as const),
);

const IDIOMATIC = `import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";

const Message = defineMessageUnion({
  ClickedSend: {},
  UpdatedPrompt: { value: Schema.String },
});

type Message = typeof Message.Type;

type Model = Readonly<{ prompt: string; maybeDraft: Option.Option<string> }>;

function trimmed(value: string): string {
  return value.trim();
}

export function update(model: Model, message: Message): Model {
  return Message.match<Model>(message, {
    ClickedSend: () => ({ ...model, maybeDraft: Option.map(model.maybeDraft, trimmed) }),
    UpdatedPrompt: ({ value }) => ({ ...model, prompt: value }),
  });
}

export const sent = Message.ClickedSend();
`;

const SWITCH_ON_TAG = `import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";

const Message = defineMessageUnion({
  ClickedSend: {},
  UpdatedPrompt: { value: Schema.String },
});

type Message = typeof Message.Type;

export function update(prompt: string, message: Message): string {
  switch (message._tag) {
    case "ClickedSend":
      return "";
    case "UpdatedPrompt":
      return message.value;
  }
}
`;

RuleTester.describe = (text, fn) => {
  void describe(text, fn);
};

RuleTester.it = (text, fn) => {
  void it(text, fn);
};

const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("the Foldkit lint rules for the owner page", () => {
  it("decides every rule the plugin ships", () => {
    assert.deepEqual([...pageRules.keys()].toSorted(), [...shippedRules.keys()].toSorted());
  });
});

for (const [name, rule] of shippedRules) {
  if (pageRules.get(name) === "error") {
    ruleTester.run(name, rule, { valid: [IDIOMATIC], invalid: [] });
  }
}

ruleTester.run("foldkit/no-switch-on-message-tag", foldkit.rules["no-switch-on-message-tag"], {
  valid: [],
  invalid: [{ code: SWITCH_ON_TAG, errors: 1 }],
});
