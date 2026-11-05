import { describe, expect, it } from "vitest";
import { chosenExecBackend } from "../../../src/workspace/project/computer-adapter.js";
import { routedBackend } from "../../../src/workspace/project/exec-routing.js";

const ROUTES: ReadonlyArray<readonly [string, "isolate" | "container" | undefined, string]> = [
  ["ls -la", undefined, "isolate"],
  ["cat a.txt | grep foo | sort | uniq -c | head -5", undefined, "isolate"],
  ["cd src && find . -name '*.ts' | wc -l", undefined, "isolate"],
  ["grep 'a|b; c' file > out.txt 2>&1", undefined, "isolate"],
  ["jq .name package.json", undefined, "isolate"],
  ["git status && git log --oneline | head", undefined, "isolate"],
  ["git push origin main", undefined, "container"],
  ["git -C x status", undefined, "container"],
  ["git log && node --version", undefined, "container"],
  ["pnpm test", undefined, "container"],
  ["ls && pnpm test", undefined, "container"],
  ["curl https://example.com", undefined, "container"],
  ["echo $(whoami)", undefined, "container"],
  ["echo `whoami`", undefined, "container"],
  ["(cd src; ls)", undefined, "container"],
  ["PATH=/x ls", undefined, "container"],
  ["FOO=1 ls", undefined, "isolate"],
  ["LD_PRELOAD=x ls", undefined, "container"],
  ["FOO=1", undefined, "container"],
  ["./run.sh", undefined, "container"],
  ["for f in *; do cat $f; done", undefined, "container"],
  ["cat <<EOF\nhi\nEOF", undefined, "container"],
  ["find . -exec rm {} ;", undefined, "container"],
  ["xargs rm", undefined, "container"],
  ["echo 'unterminated", undefined, "container"],
  ["", undefined, "container"],
  ["ls", "container", "container"],
  ["ls", "isolate", "isolate"],
  ["git pull", "isolate", "container"],
  ["node -e 1 | cat", "isolate", "container"],
];

describe("routedBackend", () => {
  it.each(ROUTES)("%s (%s) goes to %s", (command, requested, expected) => {
    expect(routedBackend(command, requested)).toBe(expected);
  });
});

function recordingWorkspace(backends: string[]): Parameters<typeof chosenExecBackend>[0] {
  const exec: Parameters<typeof chosenExecBackend>[0]["runtime"]["exec"] = (_source, options) => {
    backends.push(options.backend);

    return Promise.reject(new Error("stop"));
  };

  return { runtime: { exec } };
}

describe("chosenExecBackend routing", () => {
  it("never sends a container-only command to the isolate", async () => {
    const backends: string[] = [];

    const backend = chosenExecBackend(recordingWorkspace(backends), { generation: 1 });

    for (const [command, backendChoice] of [
      ["git push", "isolate"],
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
