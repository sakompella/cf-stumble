import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { compatibility } from "../infra/worker-settings.js";

const PROBE = "export default { fetch: () => Response.json(Cloudflare.compatibilityFlags) };";

const VITEST_RUNNER_FLAGS = ["handle_cross_request_promise_resolution", "unsafe_module"];

function enabledFlags(flags: Readonly<Record<string, boolean>>): readonly string[] {
  return Object.keys(flags).filter((flag) => flags[flag] === true);
}

test("the tests run with exactly the compatibility features of the production Worker", async () => {
  const production = env.LOADER.load({
    compatibilityDate: compatibility.date,
    compatibilityFlags: [...compatibility.flags],
    mainModule: "probe.js",
    modules: { "probe.js": PROBE },
    globalOutbound: null,
  });

  const response = await production.getEntrypoint().fetch("https://probe.test/");

  const productionFlags = enabledFlags(await response.json<Record<string, boolean>>());

  const testFlags = enabledFlags(Cloudflare.compatibilityFlags);

  const differing = [
    ...testFlags.filter((flag) => !productionFlags.includes(flag)),
    ...productionFlags.filter((flag) => !testFlags.includes(flag)),
  ];

  expect(differing.toSorted()).toEqual(VITEST_RUNNER_FLAGS);
});
