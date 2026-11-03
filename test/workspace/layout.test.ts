import { expect, test } from "vitest";
import { resolveInWorkspace } from "../../src/facet/generation-1/execution-env-paths.js";
import { parseAddressedPath } from "../../src/workspace/project/resolve.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import {
  HARNESS_DIRECTORY,
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  projectDirectory,
  WORKSPACE_ROOT,
} from "../../src/workspace-layout.js";

const projectOne = sampleProjectOne;

const projectTwo = sampleProjectTwo;

test("the facet guard and the addressed-path space share one root", () => {
  const inside = [
    WORKSPACE_ROOT,
    HARNESS_DIRECTORY,
    projectDirectory(projectTwo.id),
    MANAGED_AGENT_INSTRUCTIONS_PATH,
  ];

  for (const path of inside) {
    const resolved = resolveInWorkspace(projectDirectory(projectOne.id), path);

    if (!resolved.ok) {
      throw new Error(`${path} is inside the workspace and must resolve`);
    }

    expect(resolved.value.absolute).toBe(path);
    expect(
      parseAddressedPath(resolved.value.addressed).ok,
      "what the guard admits, the target must be able to address",
    ).toBe(true);
  }
});
