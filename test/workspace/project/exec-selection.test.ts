import { describe, expect, it } from "vitest";
import { chosenExecBackend, routedBackend } from "../../../src/workspace/project/exec-selection.js";

const ROUTES: ReadonlyArray<readonly [string, "isolate" | "container" | undefined, string]> = [
  ["ls -la", undefined, "isolate"],
  ["cat a.txt | grep foo | sort | uniq -c | head -5", undefined, "isolate"],
  ["cd src && find . -name '*.ts' | wc -l", undefined, "isolate"],
  ["grep 'a|b; c' file > out.txt 2>&1", undefined, "isolate"],
  ["jq .name package.json", undefined, "isolate"],
  ["git status", undefined, "isolate"],
  ["git status --short", undefined, "isolate"],
  ["git branch -vv", undefined, "isolate"],
  ["git stash list", undefined, "isolate"],
  ["git log --oneline | head", undefined, "isolate"],
  ["ls && git diff", undefined, "isolate"],
  ["git log", "isolate", "isolate"],
  ["git push origin main", undefined, "isolate"],
  ["git -C x status", undefined, "isolate"],
  ["git log && node --version", undefined, "container"],
  ["pnpm test", undefined, "container"],
  ["ls && pnpm test", undefined, "container"],
  ["curl https://github.com/owner/repo", undefined, "isolate"],
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
  ["git pull", "isolate", "isolate"],
  ["node -e 1 | cat", "isolate", "container"],
  ["printf 'h\u00C9llo \u2713\\n' > /tmp/u.txt && cat /tmp/u.txt", undefined, "container"],
  ["printf 'x' > /tmp/u.txt", undefined, "container"],
  ["cat /tmp/u.txt", undefined, "container"],
  ["ls /tmp", undefined, "container"],
  ["cat /workspace/notes.txt", undefined, "isolate"],
  ["cat /workspace/../workspace/x", undefined, "isolate"],
  ["echo hi > out.txt", undefined, "isolate"],
  ["echo hi > /dev/null", undefined, "isolate"],
  ["cat /dev/null", undefined, "isolate"],
  ["curl -s -o /dev/null -w '%{http_code}' https://github.com/owner/repo", undefined, "isolate"],
  ["echo hi > /dev/stdout", undefined, "container"],
  ["echo hi > /dev/stderr", undefined, "container"],
  ["cat /dev/zero", undefined, "container"],
  ["ls /dev", undefined, "container"],
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
