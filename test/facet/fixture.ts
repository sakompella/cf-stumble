import * as Result from "effect/Result";
import { MainHarnessArtifact } from "../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../src/facet/artifact.js";
import { FACET_COMPATIBILITY } from "../../src/facet-compatibility.js";
import { STARTUP_CHECK_REPLY } from "../../src/startup-check-script.js";
import { WORKSPACE_ROOT } from "../../src/workspace-layout.js";

export function parsedArtifact(input: MainHarnessArtifactInput): MainHarnessArtifact {
  const parsed = MainHarnessArtifact.parse(input);

  if (Result.isFailure(parsed)) {
    throw new Error(`a test artifact must parse: ${parsed.failure.code}`);
  }

  return parsed.success;
}

export const FACET_COMPATIBILITY_METHOD = `compatibility() { return ${JSON.stringify(FACET_COMPATIBILITY)}; }`;

export const STARTUP_CHECK_CONVERSATION = `conversation:${WORKSPACE_ROOT}`;

const startupCheckAnswered = `${JSON.stringify({
  type: "snapshot",
  entries: [
    {
      id: 1,
      kind: "message",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: STARTUP_CHECK_REPLY }],
          stopReason: "stop",
        },
      ],
    },
  ],
  tools: [],
  inbox: [],
})}\n`;

export const ANSWER_STARTUP_CHECK = `if (conversationId.split(":")[1] === ${JSON.stringify(WORKSPACE_ROOT)}) return new Response(${JSON.stringify(startupCheckAnswered)}).body;`;

export function servingFacetSource(
  served: string,
  versionMethod = FACET_COMPATIBILITY_METHOD,
  attachMethod = "async attach() {}",
): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${versionMethod}
  ${attachMethod}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { return 1; }
  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
    return new Response(${JSON.stringify(served)}).body;
  }
}
`;
}

export const fixtureMainHarnessCommit = "f53a0e1c1bdbe213ab700a84b1db23615cc24b02";

export const fixtureMainHarnessArtifact: MainHarnessArtifactInput = {
  harnessCommit: fixtureMainHarnessCommit,
  entryModule: "main-facet.js",
  modules: [{ name: "main-facet.js", source: servingFacetSource(fixtureMainHarnessCommit) }],
};
