import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  artifact,
  connectedSupervisor,
  facet,
  prepareWithModuleMap,
  submitCandidate,
  ANSWER_STARTUP_CHECK,
  FACET_COMPATIBILITY_METHOD,
} from "../helpers.js";

const COMMIT = "a0a0000000000000000000000000000000000004";

const PROJECT = "sample-project-one";

const source = facet(`
  ${FACET_COMPATIBILITY_METHOD}
  async attach(host) { this.host ??= host.dup(); }
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit(conversationId, content) {
    if (content === "unreported") {
      this.unreported = conversationId;
      return 1;
    }
    await this.host.running([{ conversationId, run: 1 }]);
    await this.host.running([]);
    return 1;
  }
  async abort(conversationId) {
    if (this.unreported !== conversationId) return null;
    this.unreported = undefined;
    await this.host.running([{ conversationId, run: 1 }]);
    await this.host.running([], { [conversationId]: "aborted" });
    return null;
  }
  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
    return new Response("${COMMIT}").body;
  }
`);

afterEach(async () => {
  await reset();
});

async function serving(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = await connectedSupervisor(name);
  const label = await submitCandidate(control, COMMIT);
  await prepareWithModuleMap(control, label, artifact(COMMIT, source));
  await activateGeneration(control, label);

  return control;
}

test("an owner cancel that reaches the Supervisor before the facet's first running report settles the run cancelled", async () => {
  const control = await serving("run-cancel-before-report");
  const log = vi.spyOn(console, "log");

  await control.submitProjectMessage(PROJECT, "unreported", "r1", 30);
  await control.abortProjectRun(PROJECT);

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "cancelled" }),
  );
  expect(log).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "unanswered" }),
  );
});

test("a cancel that finds no run does not mark the owner's next run cancelled", async () => {
  const control = await serving("run-cancel-no-run");
  const log = vi.spyOn(console, "log");

  await control.submitProjectMessage(PROJECT, "done", "r1", 30);
  await control.abortProjectRun(PROJECT);
  log.mockClear();
  await control.submitProjectMessage(PROJECT, "done", "r2", 30);

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "completed" }),
  );
  expect(log).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "cancelled" }),
  );
});
