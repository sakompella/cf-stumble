import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonRecord, JsonValue } from "../json.mts";
import { gitExecLine, parseGitExecs } from "./exec-commands.mts";

interface ExecFields {
  readonly program: string;
  readonly backend?: string;
  readonly fellBackFrom?: string;
  readonly isolateRefused?: boolean;
  readonly writeFormRefused?: boolean;
}

const finished = (fields: ExecFields): JsonRecord => ({
  timestamp: 1,
  source: {
    event: "exec.finished",
    backend: "isolate",
    fellBackFrom: null,
    isolateRefused: false,
    writeFormRefused: false,
    ...fields,
  },
});

const page = (rows: readonly JsonRecord[]): JsonValue => ({
  result: { events: { events: [...rows] } },
});

const fixture = page([
  finished({ program: "git status" }),
  finished({ program: "git status" }),
  finished({ program: "git diff" }),
  finished({ program: "git commit", backend: "container" }),
  finished({
    program: "git commit",
    backend: "container",
    fellBackFrom: "isolate",
    isolateRefused: true,
    writeFormRefused: true,
  }),
  finished({ program: "git push", backend: "container", fellBackFrom: "isolate" }),
  finished({ program: "ls" }),
  { timestamp: 2, source: { event: "exec.finished", backend: "isolate" } },
  { timestamp: 3, source: { event: "run.settled" } },
]);

describe("parseGitExecs", () => {
  it("keeps exec.finished git events and skips other programs and older events", () => {
    const { execs, sample } = parseGitExecs(fixture);

    assert.equal(sample, false);
    assert.deepEqual(
      execs.map((exec) => exec.subcommand),
      ["status", "status", "diff", "commit", "commit", "push"],
    );
  });
});

describe("gitExecLine", () => {
  it("summarises subcommands by backend with fallback and refusal counts", () => {
    assert.deepEqual(gitExecLine(parseGitExecs(fixture)), [
      "i git commands 6, 50.0% in the isolate: container 3 (commit 2, push 1); isolate 3 (status 2, diff 1); fell back 2 (commit 1, push 1); isolate refused 1 (commit 1); write form refused 1 (commit 1)",
    ]);
  });

  it("says nothing without git commands and marks a full page as a sample", () => {
    assert.deepEqual(gitExecLine({ execs: [], sample: false }), []);

    const full = parseGitExecs(
      page(Array.from({ length: 2000 }, () => finished({ program: "git log" }))),
    );

    const [line] = gitExecLine(full);

    assert.match(line ?? "", /a sample: telemetry returned its row limit/u);
  });
});
