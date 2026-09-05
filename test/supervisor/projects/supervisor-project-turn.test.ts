/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { sampleProjectOne } from "../../project-fixtures.js";
import { activateFixtureGeneration, connectSampleProjects } from "../helpers.js";
import type {
  ProjectTurnRequest,
  ProjectTurnStart,
} from "../../../src/supervisor/projects/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

/**
 * The real Supervisor Durable Object, its real Workspace Host binding, and no capability supplied
 * by this test. `streamProjectTurn` takes a project id and a turn request and nothing else: there
 * is no parameter through which a capability, a tenant, or a workspace name could arrive, so
 * whatever reaches the generation the Supervisor named and obtained itself.
 */

const request: ProjectTurnRequest = {
  projectId: sampleProjectOne.id,
  request: { prompt: "do the work", state: null },
};

/**
 * A Supervisor holding the tenant's two connected projects. The catalog is storage now, so a test
 * that names a project has to connect it first, exactly as the owner does.
 */
async function supervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await connectSampleProjects(control);
  return control;
}

afterEach(async () => {
  await reset();
});

test("the turn surface accepts a project id and a request, and never a tenant or capability", () => {
  expectTypeOf<Parameters<Supervisor["streamProjectTurn"]>>().toEqualTypeOf<[ProjectTurnRequest]>();
  expectTypeOf<ProjectTurnRequest>().toEqualTypeOf<{
    readonly projectId: unknown;
    readonly request: unknown;
  }>();
});

test("a Supervisor with nothing serving refuses the turn", async () => {
  const control = await supervisor("project-turn-without-a-generation");

  const refused: ProjectTurnStart = await control.streamProjectTurn(request);

  expect(refused).toEqual({ ok: false, reason: "no-active-generation" });
});

/**
 * What the local runtime can show about the obtaining step. The Supervisor mounts the fixture
 * generation, then asks its own `WORKSPACE_HOST` binding for the project capability, and that call
 * fails here because the real `WorkspaceHost` constructor needs a container-enabled Durable Object
 * and this runtime has none. A test-supplied capability could not produce this outcome; only the
 * Supervisor reaching for its own binding can.
 */
test("a serving Supervisor goes on to obtain the capability from its own binding", async () => {
  const control = await supervisor("project-turn-reaches-the-workspace-binding");
  await activateFixtureGeneration(control);

  const refused: ProjectTurnStart = await control.streamProjectTurn(request);

  expect(refused).toEqual({ ok: false, reason: "workspace-unavailable" });
});
