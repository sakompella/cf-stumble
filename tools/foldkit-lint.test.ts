import assert from "node:assert/strict";
import { describe, it } from "node:test";
import foldkit from "@foldkit/oxlint-plugin";
import config from "../oxlint.config.ts";

const PREFIX = "foldkit/";

const pageRules = new Map([
  ...Object.entries(config.rules).filter(([name]) => name.startsWith(PREFIX)),
  ...(config.overrides ?? []).flatMap((override) =>
    override.files.includes("src/page/client/**")
      ? Object.entries(override.rules ?? {}).filter(([name]) => name.startsWith(PREFIX))
      : [],
  ),
]);

const shippedRules = Object.keys(foldkit.rules).map((name) => `${PREFIX}${name}`);

describe("the Foldkit lint rules for the owner page", () => {
  it("decides every rule the plugin ships", () => {
    assert.deepEqual([...pageRules.keys()].toSorted(), shippedRules.toSorted());
  });
});
