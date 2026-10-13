import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { sampleProjectOne, sampleSelectableCatalog } from "../../project-fixtures.js";
import { HARNESS_PROJECT_ID } from "../../../src/selectable-projects.js";
import { startFacetTurn } from "../../../src/supervisor/projects/index.js";
import { says } from "../../facet/generation-0/facet-turn-helpers.js";

import {
  facetRunning,
  projectWorkspaces,
  turnRecordingProvisioning,
  workspaceName,
} from "./project-turn-helpers.js";
import { wholeTurn } from "./turn-workspace-fakes.js";

test("a harness turn reconciles before mounting the generation", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);
  const events: string[] = [];

  const start = await Effect.runPromise(
    startFacetTurn({
      namespace: workspaces.namespace,
      mount: () => {
        events.push("mount");

        return Effect.succeed({ fetcher: facet });
      },
      provision: () => Effect.succeed(true),
      provisionHarness: () => {
        events.push("provision-harness");

        return Effect.succeed(true);
      },
      catalog: sampleSelectableCatalog,
      workspaceName,
      projectId: HARNESS_PROJECT_ID,
      request: { prompt: "do the work", state: null },
      signal: new AbortController().signal,
      remainingMs: wholeTurn,
    }),
  );

  expect(start).toMatchObject({ ok: true });
  expect(events).toEqual(["provision-harness", "mount"]);
});

test("a harness provision that observes cancellation never mounts", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);
  const controller = new AbortController();
  let mounted = false;

  const start = await Effect.runPromise(
    startFacetTurn({
      namespace: workspaces.namespace,
      mount: () => {
        mounted = true;

        return Effect.succeed({ fetcher: facet });
      },
      provision: () => Effect.succeed(true),
      provisionHarness: () => {
        controller.abort();

        return Effect.succeed(false);
      },
      catalog: sampleSelectableCatalog,
      workspaceName,
      projectId: HARNESS_PROJECT_ID,
      request: { prompt: "do the work", state: null },
      signal: controller.signal,
      remainingMs: wholeTurn,
    }),
  );

  expect(start).toEqual({ ok: false, reason: "turn-not-started" });
  expect(mounted).toBe(false);
});

test("a repository turn reconciles its own clone", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);
  const project = await turnRecordingProvisioning(workspaces, facet, sampleProjectOne.id);

  expect(project.start).toMatchObject({ ok: true });
  expect(project.provisioned).toEqual([sampleProjectOne.id]);
});
