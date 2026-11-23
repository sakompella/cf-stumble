import { expect, test, vi } from "vitest";
import { computerEnv } from "../../../src/facet/generation-1/computer-env.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";
import { hostWith } from "./conversation-host.js";
import { unscriptedGenerations } from "./generation-control.js";

const signal = new AbortController().signal;

const unused = () => Promise.reject(new Error("not used"));

const workspace: ProjectRpcTargetContract & Disposable = {
  lstat: unused,
  readFile: unused,
  writeFile: unused,
  kill: unused,
  endTurn: unused,
  startExec: unused,
  [Symbol.dispose]: () => {},
};

test("the facet's environment sends a tailnet fetch to the host it is attached to", async () => {
  const tailnetFetch = vi.fn<NonNullable<ReturnType<typeof hostWith>["tailnetFetch"]>>(() =>
    Promise.resolve(new Response("up")),
  );

  const host = hostWith({ workspace: () => Promise.resolve(workspace), tailnetFetch });
  const env = await computerEnv(host, unscriptedGenerations, "1", "/workspace/project", signal);
  const response = await env.tailnetFetch?.("http://100.64.0.7/", { method: "GET" });

  expect(tailnetFetch).toHaveBeenCalledWith("http://100.64.0.7/", { method: "GET" });
  expect(await response?.text()).toBe("up");
});

test("the facet's environment refuses a tailnet fetch when the host provides none", async () => {
  const host = hostWith({ workspace: () => Promise.resolve(workspace) });
  const env = await computerEnv(host, unscriptedGenerations, "1", "/workspace/project", signal);

  await expect(env.tailnetFetch?.("http://100.64.0.7/")).rejects.toThrow("provides no tailnet");
});
