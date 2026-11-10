import { describe, expect, it } from "vitest";
import { chosenExecBackend } from "../../../src/workspace/project/exec-selection.js";

function recordingWorkspace(backends: string[]): Parameters<typeof chosenExecBackend>[0] {
  const exec: Parameters<typeof chosenExecBackend>[0]["runtime"]["exec"] = (_source, options) => {
    backends.push(options.backend);

    return Promise.reject(new Error("stop"));
  };

  return {
    runtime: { exec },
    pull: () => {
      throw new Error("stop");
    },
  };
}

describe("chosenExecBackend routing", () => {
  it("never sends a container-only command to the isolate", async () => {
    const backends: string[] = [];

    const backend = chosenExecBackend(recordingWorkspace(backends), { generation: 1 });

    for (const [command, backendChoice] of [
      ["pnpm test", "isolate"],
      ["pnpm install", undefined],
      ["ls", undefined],
      ["ls", "container"],
    ] as const) {
      await backend
        .exec({ command, cwd: "/", timeoutMs: 1, backend: backendChoice })
        .catch(() => {});
    }

    expect(backends).toEqual([
      "container-shell",
      "container-shell",
      "worker-shell",
      "container-shell",
    ]);
  });
});
