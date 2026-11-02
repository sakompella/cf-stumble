import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  activateGeneration,
  artifact,
  prepareWithModuleMap,
  servedText,
  submitCandidate,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
} from "../supervisor/helpers.js";

const reportingCommit = "e0e0000000000000000000000000000000000001";

async function servedReport(name: string): Promise<string> {
  const control = env.SUPERVISOR.getByName(name);
  const label = await submitCandidate(control, reportingCommit);

  await prepareWithModuleMap(
    control,
    label,
    artifact(
      reportingCommit,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${FACET_COMPATIBILITY_METHOD}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { return 1; }
  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
    const outbound = await fetch("https://example.com/").then(() => "allowed", () => "blocked");
    return new Response("bindings " + Object.keys(this.env).sort().join(",") + "; outbound " + outbound).body;
  }
}
`,
    ),
  );
  await activateGeneration(control, label);

  return servedText(control);
}

afterEach(async () => {
  await reset();
});

test("runs the main facet with only the model capability and no ambient outbound", async () => {
  expect(await servedReport("mounted-facet-capabilities")).toBe("bindings MODEL; outbound blocked");
});
