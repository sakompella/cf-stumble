import { bindings } from "cf/config";
import { expect, test } from "vitest";
import cloudflareConfig from "../../cloudflare.config.js";

test("the test-mode configuration equals production apart from the Worker name and the AI binding", () => {
  const production = cloudflareConfig({ mode: undefined, isPreview: false });
  const testing = cloudflareConfig({ mode: "test", isPreview: false });
  const aiEntry = `,"AI":${JSON.stringify(bindings.ai({}))}`;

  expect(JSON.stringify(production)).toContain(aiEntry);
  expect(JSON.stringify(testing)).toBe(
    JSON.stringify(production)
      .replace(aiEntry, "")
      .replaceAll(`"${production.worker.name}"`, `"${testing.worker.name}"`),
  );
});
