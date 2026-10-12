import { afterEach, expect, test, vi } from "vitest";
import { resultOf } from "../../effect-result.js";
import * as Result from "effect/Result";
import { capturedEvents, everythingLogged, named } from "../../log-capture.js";
import { namespaceFor } from "../../workspace-namespace-fixture.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  planHarnessBuild,
  type HarnessBuildRequest,
} from "../../../src/harness-build.js";
import { WorkspaceHostModuleMapBuilder } from "../../../src/supervisor/artifacts/index.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";

/**
 * Why a build has one step per phase. Three deployed builds of one commit died at 671 s, 692 s
 * and 696 s: two lost the Durable Object, and one exited 1 with an empty stdout and an empty
 * stderr. Every one of them reported the whole build as `build` and left nothing behind that said
 * which phase had been running. A phase is now its own step, so it is its own RPC, its own exit
 * code and its own bounded tail, and no one command has to survive eleven minutes.
 */

const commit = testHarnessCommit("6000000000000000000000000000000000000003");

const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");

const phaseNames = HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name);

/** Fails the one step the test names and reports every step it was asked for. */
class PhaseFailingHost implements BuildWorkspaceHost {
  readonly steps: string[] = [];
  private readonly failing: string;

  constructor(failing: string) {
    this.failing = failing;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    if (request.kind === "build-output") {
      this.steps.push("build-output");

      return Promise.resolve({
        ok: true,
        result: { kind: "command", stdout: "{}", stderr: "", exitCode: 0 },
      });
    }

    this.steps.push(request.step);
    const failed = request.step === this.failing;

    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: "",
        stderr: failed ? `${request.step} failed` : "",
        exitCode: failed ? 7 : 0,
      },
    });
  }
}

test("plans each build phase as its own step, in the order the phases depend on", () => {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

  expect(plan.steps.map((step) => step.name)).toEqual([
    "provision",
    "isolate",
    "checkout",
    ...phaseNames,
  ]);

  for (const phase of HARNESS_BUILD_CONFIGURATION.buildPhases) {
    const own = plan.steps.filter((step) => step.source.includes(phase.command));
    expect(
      own.map((step) => step.name),
      `${phase.command} belongs to the ${phase.name} step and to no other`,
    ).toEqual([phase.name]);
  }
});

test("a failing phase names that phase, and the phases after it never run", async () => {
  const outcomes = await Promise.all(
    phaseNames.map(async (failing) => {
      const host = new PhaseFailingHost(failing);

      const built = await resultOf(
        new WorkspaceHostModuleMapBuilder(namespaceFor(host), workspaceName).build(commit),
      );

      return {
        failing,
        error: Result.isFailure(built) ? built.failure : undefined,
        steps: host.steps,
      };
    }),
  );

  for (const outcome of outcomes) {
    expect(outcome.error, `the ${outcome.failing} phase must report its own failure`).toEqual({
      code: "build-step-failed",
      harnessCommit: commit,
      step: outcome.failing,
      exitCode: 7,
      diagnostics: { stdoutTail: "", stderrTail: `${outcome.failing} failed`, truncated: false },
    });
    expect(outcome.steps.at(-1), "a build stops at the phase that failed").toBe(outcome.failing);
    expect(
      outcome.steps.slice(0, 3),
      "and the phases still run after the commit is provisioned, isolated and extracted",
    ).toEqual(["provision", "isolate", "checkout"]);
  }
});

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

/** Fails one named step with output that echoes a token, as a failed authenticated fetch does. */
class TokenEchoingHost implements BuildWorkspaceHost {
  private readonly failing: string;

  constructor(failing: string) {
    this.failing = failing;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    const failed = request.kind === "build-step" && request.step === this.failing;

    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: failed ? `fetching https://x-access-token:${FAKE_TOKEN}@github.com/o/r` : "{}",
        stderr: failed ? `fatal: authentication failed for ${FAKE_TOKEN}` : "",
        exitCode: failed ? 7 : 0,
      },
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a failed phase gives the owner its output tail with every credential redacted, and logs none of it", async () => {
  const events = capturedEvents();

  const built = await resultOf(
    new WorkspaceHostModuleMapBuilder(
      namespaceFor(new TokenEchoingHost(phaseNames[0] ?? "")),
      workspaceName,
    ).build(commit),
  );

  if (Result.isSuccess(built) || built.failure.code !== "build-step-failed") {
    throw new Error("the phase must fail with a build-step-failed problem");
  }

  const { diagnostics } = built.failure;
  expect(diagnostics.stderrTail, "the owner can read why the build failed").toContain(
    "authentication failed",
  );
  expect(JSON.stringify(diagnostics), "a credential never reaches even the owner").not.toContain(
    FAKE_TOKEN,
  );
  expect(diagnostics.truncated).toBe(false);

  const logged = everythingLogged();
  expect(logged, "command output is not written to a log").not.toContain("authentication failed");
  expect(logged).not.toContain("x-access-token");
  expect(logged).not.toContain(FAKE_TOKEN);
  expect(named(events(), "harness-build.step").at(-1)).toMatchObject({
    step: phaseNames[0],
    outcome: "build-step-failed",
    exitCode: 7,
  });
});

test("the tail keeps the end of a long stream and says it was cut", async () => {
  const host = new LongOutputHost(phaseNames[0] ?? "");

  const built = await resultOf(
    new WorkspaceHostModuleMapBuilder(namespaceFor(host), workspaceName).build(commit),
  );

  if (Result.isSuccess(built) || built.failure.code !== "build-step-failed") {
    throw new Error("the phase must fail with a build-step-failed problem");
  }

  expect(built.failure.diagnostics.stderrTail).toHaveLength(2_000);
  expect(built.failure.diagnostics.stderrTail.endsWith("THE END")).toBe(true);
  expect(built.failure.diagnostics.truncated).toBe(true);
});

/** Fails the named step with exactly the output the test gives it. */
class FixedOutputHost implements BuildWorkspaceHost {
  private readonly failing: string;
  private readonly stdout: string;
  private readonly stderr: string;

  constructor(failing: string, output: Readonly<{ stdout: string; stderr: string }>) {
    this.failing = failing;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    const failed = request.kind === "build-step" && request.step === this.failing;

    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: failed ? this.stdout : "{}",
        stderr: failed ? this.stderr : "",
        exitCode: failed ? 7 : 0,
      },
    });
  }
}

async function failedDiagnostics(output: Readonly<{ stdout: string; stderr: string }>) {
  const built = await resultOf(
    new WorkspaceHostModuleMapBuilder(
      namespaceFor(new FixedOutputHost(phaseNames[0] ?? "", output)),
      workspaceName,
    ).build(commit),
  );

  if (Result.isSuccess(built) || built.failure.code !== "build-step-failed") {
    throw new Error("the phase must fail with a build-step-failed problem");
  }

  return built.failure.diagnostics;
}

test("a token that straddles the cut is redacted before the cut, so no fragment survives", async () => {
  const token = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
  // The 2,000-character window of the raw text would start in the middle of the token.
  const stderr = `${token} ${"y".repeat(1_979)}`;

  const { stderrTail } = await failedDiagnostics({ stdout: "", stderr });

  for (let length = 8; length <= token.length; length += 1) {
    expect(stderrTail, `${length} characters of the token`).not.toContain(token.slice(0, length));
    expect(stderrTail, `the last ${length} characters of the token`).not.toContain(
      token.slice(-length),
    );
  }

  expect(stderrTail.endsWith("y")).toBe(true);
});

test("an Access token in the output is redacted from the owner's tail too", async () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl";

  const { stdoutTail, stderrTail } = await failedDiagnostics({
    stdout: `cookie CF_Authorization=${jwt}`,
    stderr: `denied for ${jwt}`,
  });

  expect(stdoutTail).not.toContain("eyJ");
  expect(stderrTail).not.toContain("eyJ");
  expect(stderrTail).toContain("denied for");
});

test("the cut never leaves half of a surrogate pair", async () => {
  const { stderrTail } = await failedDiagnostics({ stdout: "", stderr: `${"😀".repeat(1_000)}x` });

  expect(stderrTail.codePointAt(0)).toBe(0x1f600);
  expect(stderrTail.endsWith("😀x")).toBe(true);
});

class LongOutputHost implements BuildWorkspaceHost {
  private readonly failing: string;

  constructor(failing: string) {
    this.failing = failing;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    const failed = request.kind === "build-step" && request.step === this.failing;

    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: "{}",
        stderr: failed ? `${"x".repeat(5_000)}THE END` : "",
        exitCode: failed ? 7 : 0,
      },
    });
  }
}
