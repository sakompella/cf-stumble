import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ConnectedProjects } from "../../../src/supervisor/projects/connected-projects.js";
import {
  lifecycleStep,
  LifecycleEvent,
  type ProjectState,
} from "../../../src/supervisor/projects/project-lifecycle-machine.js";
import { projectIdOf } from "../../project-fixtures.js";

afterEach(async () => {
  await reset();
});

const events = Object.values(LifecycleEvent.cases).map((variant) => variant.make({}));

function sequences(depth: number): readonly (readonly LifecycleEvent[])[] {
  return depth === 0
    ? [[]]
    : sequences(depth - 1).flatMap((prefix) => events.map((event) => [...prefix, event]));
}

test("the stored state follows the transition, and only connected projects are listed", async () => {
  const id = projectIdOf("sample-repo-1");

  await runInDurableObject(env.SUPERVISOR.getByName("lifecycle-walk"), (_instance, state) => {
    const projects = new ConnectedProjects(state.storage);

    for (const sequence of sequences(4)) {
      projects.apply(id, LifecycleEvent.cases.disconnect.make({}));
      projects.apply(id, LifecycleEvent.cases.removed.make({}));

      let expected: ProjectState | undefined;

      for (const event of sequence) {
        if (event._tag === "connect") {
          projects.connect({ repositoryUrl: "https://github.com/sample/repo-1" }, 0);
        } else {
          projects.apply(id, event);
        }

        expected = lifecycleStep(expected, event).state;

        expect(projects.stateOf(id)).toBe(expected);
        expect(projects.catalog()).toHaveLength(expected === "connected" ? 1 : 0);
      }
    }
  });
});
