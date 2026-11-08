import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { prepareWithModuleMap, submitCandidate } from "../../supervisor/helpers.js";
import { ProjectWorkspace } from "../../supervisor/conversations/project-workspace.js";
import { replaceWorkspaceHost } from "../../workspace-host-spy.js";
import { builtGeneration } from "./built-module-map.js";
import type { WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";

const GENERATION_1_COMMIT = "c0de00000000000000000000000000000000c0d1";

afterEach(async () => {
  await reset();
});

async function checkedWith(
  name: string,
  workspace: ProjectWorkspace,
  patch?: Readonly<{ commit: string; source: (source: string) => string }>,
) {
  replaceWorkspaceHost<Omit<WorkspaceHostRpc, "reset" | "backend" | "setBackend">>(
    env.WORKSPACE_HOST,
    workspace,
  );
  const control = env.SUPERVISOR.getByName(name);
  const commit = patch?.commit ?? GENERATION_1_COMMIT;
  const label = await submitCandidate(control, commit);
  const built = await builtGeneration(commit);

  const moduleMap = {
    ...built,
    modules: built.modules.map((module) => ({
      ...module,
      source: patch?.source(module.source) ?? module.source,
    })),
  };

  const checked = await prepareWithModuleMap(control, label, moduleMap);

  return { control, label, checked };
}

test("the built generation passes the Supervisor's startup check", async () => {
  const { label, checked } = await checkedWith("generation-1-module-map", new ProjectWorkspace());

  expect(checked).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label, status: "ready" } },
  });
});

test("the built generation fails its startup check when the workspace command does not run", async () => {
  const workspace = new ProjectWorkspace();
  workspace.execs.startupCheckOutput = [{ name: "exit", exitCode: 127 }];

  const { label, checked } = await checkedWith("generation-1-module-map-no-exec", workspace);

  expect(checked).toMatchObject({
    ok: true,
    report: { stage: "conversation-failed", generation: { label, status: "failed" } },
  });
});

test("the built generation fails its startup check at the parallel tool calls when its writer cannot hop (generation 11)", async () => {
  const { label, checked } = await checkedWith(
    "generation-1-module-map-no-hop",
    new ProjectWorkspace(),
    {
      commit: "c0de00000000000000000000000000000000c0d2",
      source: (source) => source.replace("new MessageChannel()", "new MissingMessageChannel()"),
    },
  );

  expect(checked).toMatchObject({
    ok: true,
    report: { stage: "conversation-failed", generation: { label, status: "failed" } },
  });
  expect(checked.ok && checked.report.reason).toContain("step parallel-tools");
});

test("the built generation fails its startup check when its stumble command is broken", async () => {
  const { label, checked } = await checkedWith(
    "generation-1-module-map-no-stumble",
    new ProjectWorkspace(),
    {
      commit: "c0de00000000000000000000000000000000c0d3",
      source: (source) =>
        source.replace(
          "function runStumble(args, ports) {",
          'function runStumble(args, ports) {\n  throw new Error("stumble is broken");',
        ),
    },
  );

  expect(checked).toMatchObject({
    ok: true,
    report: { stage: "conversation-failed", generation: { label, status: "failed" } },
  });
  expect(checked.ok && checked.report.reason).toContain("step stumble-status");
});
