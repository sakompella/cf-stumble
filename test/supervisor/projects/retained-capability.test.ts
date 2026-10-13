import * as Effect from "effect/Effect";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { sampleProjectOne, sampleSelectableCatalog } from "../../project-fixtures.js";
import {
  startFacetTurn,
  type ProjectTurnFacet,
  type ProjectTurnStart,
} from "../../../src/supervisor/projects/index.js";
import { projectWorkspaces, runningTurn, workspaceName } from "./project-turn-helpers.js";

/**
 * A mutable generation can keep a duplicate of its project capability that nobody releases. The
 * duplicate must be spent once the turn is over, however the turn ended: the Supervisor ending
 * it when the turn settles, or the turn's deadline passing with nothing ending it.
 *
 * The generation here is a small module loaded into its own isolate. It keeps an extra duplicate,
 * returns its frame stream at once, and then goes on calling every method through that duplicate
 * until the workspace refuses one, which is what a generation that ignores the end of its turn
 * would do. The capability comes from the Workspace Host stand-in in a second isolate, so every
 * call crosses Workers RPC as it does when deployed.
 */

const generationSource = `
import { WorkerEntrypoint } from "cloudflare:workers";

const late = new TextEncoder().encode("written after the turn");

async function afterTheTurn(kept) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await kept.listFiles("/")).ok) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    lstat: await kept.lstat("/"),
    readFile: await kept.readFile("/kept.txt"),
    writeFile: await kept.writeFile("/late.txt", late, "overwrite"),
    listFiles: await kept.listFiles("/"),
    startExec: await kept.startExec({ command: "touch /workspace/late-command" }),
    kill: await kept.kill("00000000-0000-0000-0000-000000000000:0"),
    endTurn: await kept.endTurn(),
  };
}

export default class RetainingGeneration extends WorkerEntrypoint {
  startTurn(capability) {
    const kept = capability.dup();
    const encoder = new TextEncoder();

    return new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify(await afterTheTurn(kept))));
        controller.close();
        kept[Symbol.dispose]();
      },
    });
  }
}
`;

function retainingGeneration(): ProjectTurnFacet {
  return env.LOADER.load({
    compatibilityDate: "2025-01-01",
    mainModule: "generation.js",
    modules: { "generation.js": { js: generationSource } },
    env: {},
    globalOutbound: null,
  }).getEntrypoint<ProjectTurnFacet & Rpc.WorkerEntrypointBranded>();
}

const REFUSED = { ok: false, error: { code: "turn-ended" } };

async function startWithBudget(remainingMs: number) {
  const workspaces = await projectWorkspaces();

  const start: ProjectTurnStart = await Effect.runPromise(
    startFacetTurn({
      namespace: workspaces.namespace,
      mount: () => Effect.succeed({ fetcher: retainingGeneration() }),
      provision: () => Effect.succeed(true),
      catalog: sampleSelectableCatalog,
      workspaceName,
      projectId: sampleProjectOne.id,
      request: { prompt: "keep a duplicate", state: null },
      signal: runningTurn(),
      remainingMs: () => remainingMs,
    }),
  );

  if (!start.ok) throw new Error(`the turn must start; it was refused with ${start.reason}`);

  return { workspaces, start };
}

async function nothingLanded(workspaces: Awaited<ReturnType<typeof projectWorkspaces>>) {
  expect(await workspaces.fileText(workspaceName, "/workspace/late.txt")).toBeNull();
  expect(await workspaces.heldCommands()).toEqual([]);
}

test("a duplicate the generation kept is spent once the Supervisor ends the turn", async () => {
  const { workspaces, start } = await startWithBudget(60_000);

  start.workspace.end();

  const seen: unknown = JSON.parse(await new Response(start.frames).text());

  expect(seen).toEqual({
    lstat: REFUSED,
    readFile: REFUSED,
    writeFile: REFUSED,
    listFiles: REFUSED,
    startExec: REFUSED,
    kill: { ok: true, value: null },
    endTurn: { ok: true, value: { killed: 0 } },
  });
  await nothingLanded(workspaces);
});

test("a duplicate the generation kept is spent at the turn's deadline when nothing ends it", async () => {
  const { workspaces, start } = await startWithBudget(200);

  const seen: unknown = JSON.parse(await new Response(start.frames).text());

  expect(seen).toMatchObject({
    lstat: REFUSED,
    readFile: REFUSED,
    writeFile: REFUSED,
    listFiles: REFUSED,
    startExec: REFUSED,
  });
  await nothingLanded(workspaces);
  start.workspace.end();
});
