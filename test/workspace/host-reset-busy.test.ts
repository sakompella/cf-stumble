import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { restoreWorkspaceMembers, stubWorkspaceMember } from "./host-fixtures.js";

afterEach(restoreWorkspaceMembers);

test("a reset is refused while a credential status read is still running", async () => {
  const heldCommands: (() => void)[] = [];

  const runtime = {
    exec: async () => {
      await new Promise<void>((resolve) => {
        heldCommands.push(resolve);
      });

      return {
        result: () =>
          Promise.resolve({
            stdout: "connected octocat\n",
            stderr: "",
            exitCode: 0,
            sync: { status: "complete", applied: 0, skipped: [] },
          }),
      };
    },
  };

  stubWorkspaceMember("runtime", runtime);

  const refused = await runInDurableObject(
    env.SUPERVISOR.getByName("host-reset-busy"),
    async (_instance, state) => {
      Object.defineProperty(state, "container", { value: {}, configurable: true });
      const host = new WorkspaceHost(state, {});
      const status = host.credential({ kind: "github-credential", step: "status" });
      await vi.waitFor(() => {
        expect(heldCommands).toHaveLength(1);
      });
      const answer = await host.reset();
      heldCommands.forEach((release) => {
        release();
      });
      await status;

      return answer;
    },
  );

  expect(refused).toEqual({ ok: false, problem: { code: "workspace-busy" } });
});
