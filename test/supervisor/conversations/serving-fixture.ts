import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  artifact,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
} from "../helpers.js";

export const SCRIPTED_COMMITS = [
  "d0d0000000000000000000000000000000000001",
  "d0d0000000000000000000000000000000000002",
] as const;

function eventsMethod(harnessCommit: string): string {
  return `
  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
    const held = this.ctx.storage.kv.get("hold-events") === 1;
    const host = this.host;
    let beat;
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("${harnessCommit}|" + conversationId));
        if (!held) c.close();
        else beat = setInterval(() => c.enqueue(new TextEncoder().encode("\\n")), 20);
      },
      cancel() {
        clearInterval(beat);
        return host.log("info", "events-cancelled", {});
      },
    });
  }`;
}

export function scriptedFacet(harnessCommit: string, attachDelayMs = 0): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${FACET_COMPATIBILITY_METHOD}
  fetch() { return new Response("ready"); }
  async attach(host) {
    if (${attachDelayMs} > 0) await host.log("info", "attach-held", {});
    await new Promise((resume) => setTimeout(resume, ${attachDelayMs}));
    const refusals = this.ctx.storage.kv.get("refuse-attach") ?? 0;
    if (refusals > 0) {
      this.ctx.storage.kv.put("refuse-attach", refusals - 1);
      throw new Error("attach refused");
    }
    this.host ??= host.dup();
  }
  async createConversation(cwd) {
    const created = (this.ctx.storage.kv.get("created") ?? 0) + 1;
    this.ctx.storage.kv.put("created", created);
    return "conversation:" + cwd + ":" + created;
  }
  async submit(conversationId, content) {
    if (content === "hold the submit") {
      await this.host.log("info", "submit-held", {});
      await new Promise((resume) => setTimeout(resume, 1000));
    }
    if (content === "refuse the next attach") this.ctx.storage.kv.put("refuse-attach", 1);
    if (content === "hold the events open") this.ctx.storage.kv.put("hold-events", 1);
    const continues = content === "continue at the deadline";
    if (continues) this.ctx.storage.kv.put("continue", 1);
    await this.host.running([continues ? { conversationId, run: 1 } : { conversationId }]);
    if (content === "fail the run") await this.host.running([], { [conversationId]: "model_error" });
    await this.host.arm({ active: true });
    const submitted = (this.ctx.storage.kv.get("submitted") ?? 0) + 1;
    this.ctx.storage.kv.put("submitted", submitted);
    return submitted;
  }
  async abort(conversationId, reason) {
    if (reason === "deadline" && this.ctx.storage.kv.get("continue") === 1) {
      return { conversationId, run: 99, continues: 1 };
    }
    await this.host.running([]);
    await this.host.arm({ active: false });
  }
  ${eventsMethod(harnessCommit)}
}
`;
}

export async function readyScripted(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
  attachDelayMs = 0,
): Promise<number> {
  const label = await submitCandidate(control, harnessCommit);
  await prepareWithModuleMap(
    control,
    label,
    artifact(harnessCommit, scriptedFacet(harnessCommit, attachDelayMs)),
  );

  return label;
}

export async function servingScripted(
  name: string,
  attachDelayMs = 0,
): Promise<DurableObjectStub<Supervisor>> {
  const control = await connectedSupervisor(name);
  await activateGeneration(
    control,
    await readyScripted(control, SCRIPTED_COMMITS[0], attachDelayMs),
  );

  return control;
}
