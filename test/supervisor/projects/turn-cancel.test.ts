/// <reference types="@cloudflare/vitest-plugin/types" />

// oxlint-disable import/max-dependencies -- One turn across three real isolates and the real thread store names each piece it runs.
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";
import { Generations } from "../../../src/supervisor/generations/index.js";
import {
  startFacetTurn,
  type ProjectTurnFacet,
  type RunProjectTurnInput,
} from "../../../src/supervisor/projects/index.js";
import { ProjectThreads } from "../../../src/supervisor/threads/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/turn-budget.js";
import { calls, says } from "../../facet/generation-0/facet-turn-helpers.js";
import { loadFixtureEntrypoint } from "../../loaded-fixture.js";
import { sampleProjectOne, sampleSelectableCatalog } from "../../project-fixtures.js";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import {
  facetRunning,
  projectWorkspaces,
  workspaceName,
  type ProjectWorkspaces,
} from "./project-turn-helpers.js";
import { admitTurn } from "./turn-run-helpers.js";
import type LoadedStreamRelayEntry from "./loaded-stream-relay-entry.js";

/**
 * A browser that leaves while the generation is quiet, as it is while a tool runs.
 *
 * `turn-lifetime.test.ts` calls the turn stream's `cancel` itself. In a deployment nothing does:
 * the stream crosses Workers RPC twice (facet to Supervisor, Supervisor to Worker), and the
 * runtime tells a stream's source that its reader has gone only when the source next writes. So
 * every hop here is a real one: the generation runs the real turn in its own isolate, its
 * capability comes from a Workspace Host stand-in in a second one, and the browser reads the
 * Supervisor's stream through a third.
 */

afterEach(async () => {
  await reset();
});

const decoder = new TextDecoder();

/** Long enough for two keepalives, and far shorter than the command or the turn's deadline. */
const PROMPTLY_MS = 5_000;

/** How long `condition` took to hold, or infinity when it did not hold promptly. */
async function until(condition: () => Promise<boolean> | boolean): Promise<number> {
  const started = Date.now();

  while (!(await condition())) {
    if (Date.now() - started > PROMPTLY_MS) return Number.POSITIVE_INFINITY;

    await scheduler.wait(50);
  }

  return Date.now() - started;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string) {
  let read = "";

  while (!read.includes(text)) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error(`the turn ended before it wrote ${text}: ${read}`);

    read += decoder.decode(chunk.value, { stream: true });
  }
}

/** A turn on the real start path, with the generation and the workspace in their own isolates. */
function turnAcrossIsolates(
  state: DurableObjectState,
  workspaces: ProjectWorkspaces,
  facet: ProjectTurnFacet,
): RunProjectTurnInput {
  const generations = new Generations(state.storage);

  return {
    projectId: sampleProjectOne.id,
    prompt: "sleep for a while",
    threads: new ProjectThreads(state.storage, () => sampleSelectableCatalog),
    attribution: () => ({ active: generations.active() }),
    start: (projectId, request, context) =>
      startFacetTurn({
        namespace: workspaces.namespace,
        mount: () => Effect.succeed({ fetcher: facet }),
        provision: () => Effect.succeed(true),
        catalog: sampleSelectableCatalog,
        workspaceName,
        projectId,
        request,
        signal: context.signal,
      }),
    now: () => Date.now(),
    leaseMs: PROJECT_TURN_LEASE_MS,
    deadlineMs: 60_000,
  };
}

test("a browser that leaves during a long command frees the project and stops the command", async () => {
  const control = await supervisor("turn-cancel-during-command");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const workspaces = await projectWorkspaces();

    // The write makes the project's directory, which the command then runs in.
    const facet = await facetRunning([
      calls("write", { path: "notes.txt", content: "before the command" }),
      calls("bash", { command: "sleep 90" }),
      says("Slept."),
    ]);

    const browser = await loadFixtureEntrypoint<LoadedStreamRelayEntry>(
      "loaded-stream-relay-fixture.json",
    );

    const input = turnAcrossIsolates(state, workspaces, facet);
    const run = await admitTurn(input);

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    const reader = (await browser.relay(run.frames)).getReader();
    await readUntil(reader, "sleep 90");
    await reader.cancel();

    const isFree = () => {
      const thread = input.threads.read(sampleProjectOne.id);

      return thread.ok && !thread.thread.turnActive;
    };

    const isKilled = async () =>
      (await workspaces.heldCommands()).some(
        (held) => held.command === "sleep 90" && held.killCalls > 0,
      );

    return { freedAfterMs: await until(isFree), killedAfterMs: await until(isKilled) };
  });

  expect(observed.freedAfterMs).toBeLessThan(PROMPTLY_MS);
  expect(observed.killedAfterMs).toBeLessThan(PROMPTLY_MS);
});
