import { afterEach, expect, test, vi } from "vitest";
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

      const built = await new WorkspaceHostModuleMapBuilder(
        namespaceFor(host),
        workspaceName,
      ).build(commit);

      return { failing, error: built.isErr() ? built.error : undefined, steps: host.steps };
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

  const built = await new WorkspaceHostModuleMapBuilder(
    namespaceFor(new TokenEchoingHost(phaseNames[0] ?? "")),
    workspaceName,
  ).build(commit);

  if (built.isOk() || built.error.code !== "build-step-failed") {
    throw new Error("the phase must fail with a build-step-failed problem");
  }

  const { diagnostics } = built.error;
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

  const built = await new WorkspaceHostModuleMapBuilder(namespaceFor(host), workspaceName).build(
    commit,
  );

  if (built.isOk() || built.error.code !== "build-step-failed") {
    throw new Error("the phase must fail with a build-step-failed problem");
  }

  expect(built.error.diagnostics.stderrTail).toHaveLength(2_000);
  expect(built.error.diagnostics.stderrTail.endsWith("THE END")).toBe(true);
  expect(built.error.diagnostics.truncated).toBe(true);
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
