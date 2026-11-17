import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { MainFacet } from "../../../src/facet/generation-1/main-facet.js";
import { hostWith } from "./conversation-host.js";
import { unscriptedGenerations } from "./generation-control.js";

type Turn = Readonly<{ facet: MainFacet; id: string; reports: readonly string[] }>;

export async function inTurn(
  name: string,
  model: ModelCapability,
  body: (turn: Turn) => Promise<void>,
): Promise<void> {
  const reports: string[] = [];
  let alarm: (() => void) | undefined;

  const host = hostWith({
    arm: ({ at }) => {
      if (at !== undefined) setTimeout(() => alarm?.(), Math.max(0, at - Date.now()));

      return Promise.resolve();
    },
    running: (_conversations, failed) => {
      reports.push(...Object.values(failed ?? {}));

      return Promise.resolve();
    },
  });

  await runInDurableObject(env.SUPERVISOR.getByName(name), async (_instance, state) => {
    const facet = new MainFacet(state, env);

    alarm = () => void facet.attach(host, model, unscriptedGenerations);
    await facet.attach(host, model, unscriptedGenerations);
    const id = await facet.createConversation("/workspace");

    await facet.submit(id, "hello", "r1");
    await body({ facet, id, reports });
  });
}
