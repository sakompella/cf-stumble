import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import type { GenerationControl } from "../../../src/generation-requests.js";
import { runStumble } from "../../../src/stumble-cli/index.js";
import { withHostWorkspace } from "./host-workspace.js";

function recordingControl() {
  const reached: string[] = [];

  const reach = <T>(name: string, answer: T) => {
    reached.push(name);

    return Promise.resolve(answer);
  };

  const generations: GenerationControl = {
    generationStatus: () => reach("status", { generation: null, epoch: 4 }),
    submitGeneration: () => Promise.reject(new Error("not scripted")),
    prepareGeneration: () => Promise.reject(new Error("not scripted")),
    controlGeneration: () => Promise.reject(new Error("not scripted")),
  };

  return { reached, generations };
}

async function ran(env: ExecutionEnv, command: string | readonly string[]) {
  let output = "";

  const result = await env.exec(
    command,
    {
      onOutput: (text) => {
        output += text;
      },
    },
    BACKGROUND_CONTEXT,
  );

  return {
    exitCode: result.ok ? result.value.exitCode : result.error.code,
    output: output.replaceAll(/\/tmp\/computer-env-\w+/gu, "<workspace>"),
  };
}

function linesInAnyOrder(run: Awaited<ReturnType<typeof ran>> | undefined) {
  return run === undefined ? undefined : { ...run, output: run.output.split("\n").toSorted() };
}

test("a plain stumble command runs in the facet instead of the workspace container", async () => {
  const { reached, generations } = recordingControl();
  const expected = await runStumble(["gen", "status"], { generations });
  reached.length = 0;

  for (const command of [
    "stumble gen status",
    "  stumble   gen\tstatus\n",
    ["stumble", "gen", "status"],
  ]) {
    await withHostWorkspace(async (env) => {
      expect(await ran(env, command)).toStrictEqual({
        exitCode: expected.exitCode,
        output: expected.stdout,
      });
    }, generations);
  }

  expect(reached).toStrictEqual(["status", "status", "status"]);
});

test("a command that only resembles stumble runs in the workspace exactly as it would without it", async () => {
  const nearMisses = [
    "stumbles gen status",
    "./stumble gen status",
    "echo stumble gen status",
    "stumble gen status | cat",
    "stumble gen status; echo after",
    "stumble gen status && echo after",
    'stumble "gen" status',
    "stumble $(echo gen) status",
    "STUMBLE=1 stumble gen status",
    ["echo", "stumble"],
    ["./stumble", "gen"],
  ];

  const { reached, generations } = recordingControl();

  for (const command of nearMisses) {
    let withStumble;
    let withoutStumble;

    await withHostWorkspace(async (env) => {
      withStumble = await ran(env, command);
    }, generations);
    await withHostWorkspace(async (env) => {
      withoutStumble = await ran(env, command);
    });

    expect(linesInAnyOrder(withStumble), String(command)).toStrictEqual(
      linesInAnyOrder(withoutStumble),
    );
  }

  expect(reached).toStrictEqual([]);
});
