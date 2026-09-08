/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import type { ProjectTurnRun } from "../../../src/supervisor/projects/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

/**
 * The real Supervisor Durable Object, its real Workspace Host binding, and no capability supplied
 * by this test. `runProjectTurn` takes a project id and a prompt and nothing else: there is no
 * parameter through which a capability, a tenant, a workspace name, a conversation, or a lease
 * could arrive, so whatever reaches the generation the Supervisor named and obtained itself.
 */

afterEach(async () => {
  await reset();
});

test("the turn surface accepts a project id and a prompt, and never a tenant or capability", () => {
  expectTypeOf<Parameters<Supervisor["runProjectTurn"]>>().toEqualTypeOf<[unknown, unknown]>();
});

test("a Supervisor with nothing serving refuses the turn and keeps the thread", async () => {
  const control = await supervisor("project-turn-without-a-generation");

  const refused: ProjectTurnRun = await control.runProjectTurn("sample-project-one", "do the work");

  expect(refused).toEqual({ ok: false, problem: { code: "no-active-generation" } });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { turnActive: false, revision: 0 },
  });
});

test("a prompt that is not a turn takes no lease and reaches no generation", async () => {
  const control = await supervisor("project-turn-empty-prompt");
  await activateFixtureGeneration(control);

  const refused = await control.runProjectTurn("sample-project-one", "   ");

  expect(refused).toEqual({ ok: false, problem: { code: "invalid-prompt" } });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { turnActive: false },
  });
});

test("a project the catalog does not have reaches no thread and no workspace", async () => {
  const control = await supervisor("project-turn-unknown-project");
  await activateFixtureGeneration(control);

  expect(await control.runProjectTurn("project-nine", "do the work")).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
  expect(await control.runProjectTurn({ id: "sample-project-one" }, "do the work")).toEqual({
    ok: false,
    problem: { code: "invalid-project-id" },
  });
});

/**
 * What the local runtime can show about the obtaining step. The Supervisor mounts the fixture
 * generation, then asks its own `WORKSPACE_HOST` binding for the project capability, and that call
 * fails here because the real `WorkspaceHost` constructor needs a container-enabled Durable Object
 * and this runtime has none. A test-supplied capability could not produce this outcome; only the
 * Supervisor reaching for its own binding can.
 */
test("a serving Supervisor obtains the capability itself, and releases the lease when it cannot", async () => {
  const control = await supervisor("project-turn-reaches-the-workspace-binding");
  await activateFixtureGeneration(control);

  const refused = await control.runProjectTurn("sample-project-one", "do the work");

  expect(refused).toEqual({ ok: false, problem: { code: "workspace-unavailable" } });
  // The turn slot is free again: a turn that never started must not hold the thread until its
  // lease expires, and the next admission must not have to wait for it.
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { turnActive: false, revision: 0 },
  });
});
