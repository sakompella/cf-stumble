import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import type {
  ProjectRpcTargetContract,
  StartExecWire,
} from "../../../src/workspace/project/protocol.js";

const refused = () => Promise.reject(new Error("not used"));

function recordingTarget(started: StartExecWire[]): ProjectRpcTargetContract {
  const exited = `${JSON.stringify({ kind: "terminal", seq: 0, outcome: "exited", exitCode: 0 })}\n`;

  return {
    lstat: refused,
    readFile: refused,
    writeFile: refused,
    kill: refused,
    endTurn: refused,
    startExec: (input) => {
      started.push(input);

      return Promise.resolve({
        ok: true,
        value: { operationId: "op", events: new Response(exited).body ?? new ReadableStream() },
      });
    },
  };
}

test("the env sends no backend by default and the chosen one when asked", async () => {
  const started: StartExecWire[] = [];
  const env = createComputerEnv({ cwd: "/workspace/project", target: recordingTarget(started) });

  getOrThrow(await env.exec("ls", {}, BACKGROUND_CONTEXT));
  getOrThrow(await env.onBackend("isolate").exec("ls", {}, BACKGROUND_CONTEXT));
  getOrThrow(await env.onBackend("container").exec("ls", {}, BACKGROUND_CONTEXT));

  expect(started.map((input) => input.backend)).toEqual([undefined, "isolate", "container"]);
});
