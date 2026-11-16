import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { selectableCatalog } from "../../../src/selectable-projects.js";
import type { ProjectProvisionAnswer } from "../../../src/workspace/commands/provision-project.js";
import { capturedEvents, named } from "../../log-capture.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { HeldHost } from "./held-host.js";
import { withHeldWorkspaces } from "./held-workspaces-fixture.js";

const [project] = selectableCatalog([sampleProjectOne]);

const [, harness] = selectableCatalog([sampleProjectOne]);

afterEach(async () => {
  await reset();
});

type Failure = Readonly<{
  cause: string;
  arrange: (host: HeldHost) => void;
  code: string;
  detail: string;
}>;

const refusedClone = (answer: ProjectProvisionAnswer) => (host: HeldHost) => {
  host.clone = Promise.resolve(answer);
};

const failures: readonly Failure[] = [
  {
    cause: "a clone that exits non-zero",
    arrange: refusedClone({ ok: false, error: { code: "clone-failed", exitCode: 128 } }),
    code: "clone-failed",
    detail: "exit 128",
  },
  {
    cause: "a repository over the size limit",
    arrange: refusedClone({
      ok: false,
      error: { code: "repository-too-large", verdict: "too-many-files" },
    }),
    code: "repository-too-large",
    detail: "too-many-files",
  },
  {
    cause: "a Host that refuses the clone",
    arrange: refusedClone({ ok: false, error: { code: "workspace-busy" } }),
    code: "host-unavailable",
    detail: "workspace-busy",
  },
  {
    cause: "a Host whose clone call throws",
    arrange: (host) => {
      host.cloneError = new Error("Network connection lost");
    },
    code: "host-unavailable",
    detail: "Network connection lost",
  },
  {
    cause: "a Host that is resetting when the capability is requested",
    arrange: (host) => {
      host.projectError = new Error("workspace-busy: the workspace is resetting");
    },
    code: "host-unavailable",
    detail: "workspace-busy: the workspace is resetting",
  },
];

test.each(failures)(
  "the agent reads why the workspace is unavailable, and the log says it once: $cause",
  async ({ arrange, code, detail }) => {
    const events = capturedEvents();
    const host = new HeldHost();
    arrange(host);

    await withHeldWorkspaces("unavailable-reason", host, async (held) => {
      await expect(held.capability("conversation", project!, 1_000)).rejects.toMatchObject({
        code,
        detail,
        message: `workspace unavailable: ${code} (${detail})`,
      });
    });

    expect(named(events(), "workspace.unavailable")).toEqual([
      expect.objectContaining({ level: "warn", code, detail }),
    ]);
  },
);

test("a harness provision that exits non-zero says so with its exit code and message", async () => {
  const events = capturedEvents();
  const host = new HeldHost();

  host.built = Promise.resolve({
    ok: true,
    output: { stdout: "", stderr: "harness commit abc is not in the remote\n", exitCode: 1 },
  });

  await withHeldWorkspaces(
    "unavailable-harness",
    host,
    async (held) => {
      await expect(held.capability("conversation", harness!, 1_000)).rejects.toMatchObject({
        code: "harness-provision-failed",
        detail: "exit 1: harness commit abc is not in the remote",
      });
    },
    { activeGeneration: true },
  );

  expect(named(events(), "workspace.unavailable")).toHaveLength(1);
});

test("a workspace that was released before it answered logs nothing", async () => {
  const events = capturedEvents();
  const host = new HeldHost();

  await withHeldWorkspaces("unavailable-released", host, async (held) => {
    host.clone = new Promise(() => {});
    const capability = held.capability("conversation", project!, 1_000);

    held.end("conversation");

    await expect(capability).rejects.toMatchObject({ code: "released" });
  });

  expect(named(events(), "workspace.unavailable")).toEqual([]);
});
