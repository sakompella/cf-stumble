/// <reference types="@cloudflare/vitest-plugin/types" />

import { Result } from "better-result";
import { expect, test } from "vitest";
import { sampleProjectOne, sampleSelectableCatalog } from "../../project-fixtures.js";
import { HARNESS_PROJECT_ID } from "../../../src/selectable-projects.js";
import { streamProjectTurn } from "../../../src/supervisor/projects/index.js";
import { says } from "../../facet/generation-0/facet-turn-helpers.js";

const projectOne = sampleProjectOne;

import {
  facetRunning,
  projectWorkspaces,
  turnRecordingProvisioning,
  workspaceName,
} from "./project-turn-helpers.js";

test("a harness turn reconciles before mounting the generation", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);
  const events: string[] = [];

  const start = await streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => {
      events.push("mount");

      return Promise.resolve(Result.ok({ fetcher: facet }));
    },
    provision: () => Promise.resolve(true),
    provisionHarness: () => {
      events.push("provision-harness");

      return Promise.resolve(true);
    },
    catalog: sampleSelectableCatalog,
    workspaceName,
    projectId: HARNESS_PROJECT_ID,
    request: { prompt: "do the work", state: null },
    signal: new AbortController().signal,
  });

  expect(start).toMatchObject({ ok: true });
  expect(events).toEqual(["provision-harness", "mount"]);
});

test("a harness provision that observes cancellation never mounts", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);
  const controller = new AbortController();
  let mounted = false;

  const start = await streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => {
      mounted = true;

      return Promise.resolve(Result.ok({ fetcher: facet }));
    },
    provision: () => Promise.resolve(true),
    provisionHarness: () => {
      controller.abort();

      return Promise.resolve(false);
    },
    catalog: sampleSelectableCatalog,
    workspaceName,
    projectId: HARNESS_PROJECT_ID,
    request: { prompt: "do the work", state: null },
    signal: controller.signal,
  });

  expect(start).toEqual({ ok: false, reason: "turn-not-started" });
  expect(mounted).toBe(false);
});

test("the harness entry reconciles itself, and a repository still gets one", async () => {
  const workspaces = await projectWorkspaces();
  const harnessFacet = await facetRunning([says("Nothing to do.")]);
  const projectFacet = await facetRunning([says("Nothing to do.")]);

  const harness = await turnRecordingProvisioning(workspaces, harnessFacet, HARNESS_PROJECT_ID);
  const project = await turnRecordingProvisioning(workspaces, projectFacet, projectOne.id);

  // The harness has no catalog repository URL, but its active generation supplies the build-side
  // reconciler, so a reset can recreate the checkout before the turn starts.
  expect(harness.start).toMatchObject({ ok: true });
  expect(harness.provisioned).toEqual([HARNESS_PROJECT_ID]);
  expect(project.start).toMatchObject({ ok: true });
  expect(project.provisioned).toEqual([projectOne.id]);
});
