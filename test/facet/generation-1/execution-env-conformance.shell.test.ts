import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type ExecutionEnv, type Result } from "@earendil-works/pi-durable/env";
import { createEnvConformance, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { withHostWorkspace } from "./host-workspace.js";

const UNSUPPORTED_SUBJECTS = ["watch ", "directory reader "];

async function shellStep(env: ExecutionEnv, argv: string[]): Promise<Result<void, FileError>> {
  const ran = await env.exec(argv, undefined, BACKGROUND_CONTEXT);

  if (ran.ok && ran.value.exitCode === 0) return { ok: true, value: undefined };

  return { ok: false, error: new FileError("unknown", `${argv.join(" ")} failed`) };
}

function withShellDirectories(env: ExecutionEnv): ExecutionEnv {
  return {
    ...env,
    createDir: (path) => shellStep(env, ["mkdir", "-p", path]),
    renameFile: (source, destination) => shellStep(env, ["mv", "-f", "-T", source, destination]),
  };
}

const cases = createEnvConformance({
  assertions: createExpectAssertions(expect),
  withEnv: (use) => withHostWorkspace((env) => use(withShellDirectories(env))),
}).filter((testCase) => !UNSUPPORTED_SUBJECTS.some((subject) => testCase.name.startsWith(subject)));

describe("Computer ExecutionEnv", () => {
  for (const testCase of cases) {
    it(testCase.name, () => testCase.run(), testCase.timeoutMs);
  }
});
