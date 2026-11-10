import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { statusCommand } from "../../../src/workspace/project/git-status-command.js";

const workspace = new Workspace({
  storage: {
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync: (closure) => closure(),
  },
});

function newClient() {
  return createGitClient({ adapter: () => Promise.resolve({ promises: fsp }) })({
    ws: { provider: () => workspace.provider() },
  });
}

export async function isolateStatus(
  dir: string,
  prefix: string,
  flags: readonly string[],
): Promise<string> {
  const result = await statusCommand(
    newClient(),
    () => Promise.reject(new Error("fell back to the cli")),
    { argv: ["status", ...flags], cwd: join(dir, prefix) },
    { dir, prefix },
    (path) => fsp.readFile(path),
  );

  return result.stdout;
}
