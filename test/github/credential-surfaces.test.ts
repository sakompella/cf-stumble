/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { containsCredential } from "../../src/github/index.js";
import { ProjectConnections } from "../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import type { GitHubFetch } from "../../src/github/index.js";
import type { VerifiedAccessScope } from "../../src/access/index.js";

/**
 * Goal criterion 3, stated as a negative and checked: a credential appears in no tracked file, no
 * application log, no browser response, no stored module map, and no saved state.
 *
 * The token here is recognizable on purpose. One authorization is driven end to end against the
 * fake workspace, and then every surface that could carry it is searched. The one place it is
 * allowed is the install request into the workspace and the standard input of the one command
 * that request runs, which is where ADR-0039 puts it.
 *
 * Vite resolves the globs at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const sourceFiles = import.meta.glob("../../src/**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

const agentDocuments = import.meta.glob("../../docs/agents/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

const NOW = 1_700_000_000_000;
const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
const REPOSITORY = "https://github.com/sample/repo-1";
const owner: VerifiedAccessScope = { identity: "owner-subject", audience: "owner-audience" };

/** The modules that can hold a credential at all. None of them may write one anywhere. */
function credentialModules(): [string, string][] {
  return Object.entries(sourceFiles).filter(
    ([path]) =>
      path.includes("/src/github/") ||
      path.includes("/src/workspace/github-credential") ||
      path.includes("/src/workspace/credential-access") ||
      path.includes("/src/supervisor/projects/"),
  );
}

function githubReplying(): GitHubFetch {
  const replies = [
    {
      device_code: "device-code-secret",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
    { access_token: FAKE_TOKEN, token_type: "bearer" },
  ];
  let index = 0;
  return () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Promise.resolve(Response.json(reply));
  };
}

/** Everything the tenant's storage holds, as text, after a whole authorization and connection. */
function storedText(storage: DurableObjectStorage): string {
  const tables = storage.sql
    .exec<{ readonly name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .toArray();
  return tables
    .map((table) => JSON.stringify(storage.sql.exec(`SELECT * FROM "${table.name}"`).toArray()))
    .join("\n");
}

afterEach(async () => {
  await reset();
});

test("no tracked source file or agent document contains a credential", () => {
  const files = { ...sourceFiles, ...agentDocuments };

  const carrying = Object.entries(files)
    .filter(([, contents]) => containsCredential(contents))
    .map(([path]) => path);

  expect(Object.keys(files).length).toBeGreaterThan(20);
  expect(
    carrying,
    "a credential in the repository is also a credential in every stored module map",
  ).toEqual([]);
});

test("no module on the credential path writes to a log", () => {
  const logging = credentialModules()
    .filter(([, contents]) => /\bconsole\s*\./u.test(contents))
    .map(([path]) => path);

  expect(credentialModules().length).toBeGreaterThan(5);
  expect(logging, "an application log is one of the surfaces criterion 3 names").toEqual([]);
});

// One test drives the whole flow, because the point is what the flow as a whole leaves behind.
// oxlint-disable-next-line eslint/max-lines-per-function
test("a whole authorization leaves the token in the workspace and nowhere else", async () => {
  const workspace = new FakeTenantWorkspace();
  const name = "credential-surfaces";
  const answers: unknown[] = [];

  const stored = await runInDurableObject(
    env.SUPERVISOR.getByName(name),
    async (_instance, state) => {
      const connections = new ProjectConnections({
        storage: state.storage,
        workspaceName: tenantWorkspaceName(name),
        namespace: workspace.namespace,
        environment: {
          clientId: "Iv1.cfstumbleFAKE",
          fallbackToken: undefined,
          fetcher: githubReplying(),
        },
      });

      const started = await connections.startAuthorization(owner, NOW);
      const completed = await connections.completeAuthorization(owner, NOW + 1_000);
      const connected = await connections.connect(REPOSITORY, "Repo one", NOW + 2_000);
      const listed = await connections.list(NOW + 3_000);
      const status = await connections.connectionStatus(NOW + 4_000);
      answers.push(started, completed, connected, listed, status);
      return storedText(state.storage);
    },
  );

  expect(answers[1], "the authorization completed, so the token existed").toMatchObject({
    ok: true,
    status: { state: "connected" },
  });
  expect(
    JSON.stringify(answers),
    "every one of these values can be returned to a browser",
  ).not.toContain(FAKE_TOKEN);
  expect(JSON.stringify(answers), "the device code redeems the authorization").not.toContain(
    "device-code-secret",
  );
  expect(stored, "saved state is read back by the next request and by the page").not.toContain(
    FAKE_TOKEN,
  );
  expect(stored).not.toContain("device-code-secret");
  expect(workspace.commands.join("\n"), "no command line carries the token").not.toContain(
    FAKE_TOKEN,
  );
  expect(
    workspace.writes.filter(([, content]) => content.includes(FAKE_TOKEN)),
    "a file is a surface too: the token is written to no path at all",
  ).toEqual([]);
  expect(
    workspace.stdins.filter(([, input]) => input.includes(FAKE_TOKEN)).map(([source]) => source),
    "the token reaches exactly one command, on its standard input",
  ).toEqual([expect.stringContaining("gh auth login")]);
});
