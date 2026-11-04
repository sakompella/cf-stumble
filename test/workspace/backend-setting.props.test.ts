import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { chooseProviderPort } from "../../src/backend-setting.js";

const setting = gs.sampledFrom(["provider", "cloudflare"] as const);

const port = gs.optional(gs.integers({ minValue: 1, maxValue: 65_535 }));

test("a provider is used only when the setting says provider and one is connected", () => {
  hegel.test(
    (tc) => {
      const chosen = tc.draw(setting);
      const egressPort = tc.draw(port) ?? undefined;

      expect(chooseProviderPort(chosen, egressPort)).toBe(
        chosen === "provider" ? egressPort : undefined,
      );
    },
    { testCases: 200 },
  );
});
