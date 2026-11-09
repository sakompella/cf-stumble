import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { containsCredential } from "../../src/github/redaction.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { tenantConnections } from "../supervisor/projects/tenant-connections.js";
import type { GitHubFetch } from "../../src/github/index.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";

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

function storedText(storage: DurableObjectStorage): string {
  const tables = storage.sql
    .exec<{ readonly name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .toArray();

  return [
    ...tables.map((table) =>
      JSON.stringify(storage.sql.exec(`SELECT * FROM "${table.name}"`).toArray()),
    ),
    JSON.stringify([...storage.kv.list()]),
  ].join("\n");
}

function expectTokenOnlyOnInstallStdin(workspace: FakeTenantWorkspace): void {
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
}

afterEach(async () => {
  vi.restoreAllMocks();
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

test("a whole authorization leaves the token in the workspace and nowhere else", async () => {
  const events = capturedEvents();
  const workspace = new FakeTenantWorkspace();
  const name = "credential-surfaces";
  const answers: unknown[] = [];

  const stored = await runInDurableObject(
    env.SUPERVISOR.getByName(name),
    async (_instance, state) => {
      const { github, connections } = tenantConnections(state.storage, name, workspace, {
        clientId: "Iv1.cfstumbleFAKE",
        fallbackToken: undefined,
        fetcher: githubReplying(),
      });

      const started = await Effect.runPromise(github.startAuthorization(NOW));
      const completed = await Effect.runPromise(github.completeAuthorization(NOW + 1_000));

      const connected = await Effect.runPromise(
        connections.connect(REPOSITORY, "Repo one", NOW + 2_000),
      );

      const listed = connections.catalog();
      const status = await Effect.runPromise(github.status(NOW + 4_000));
      answers.push(started, completed, connected, listed, status, github.lastKnown(NOW + 5_000));

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
  expectTokenOnlyOnInstallStdin(workspace);
  expect(named(events(), "github-credential.install")).toEqual([
    expect.objectContaining({ source: "device-authorization", outcome: "connected" }),
  ]);

  const everything = everythingLogged();

  expect(everything, "no log line at any level carries the token").not.toContain(FAKE_TOKEN);
  expect(everything, "the device code redeems the authorization").not.toContain(
    "device-code-secret",
  );
  expect(everything, "the user code is the owner's to type").not.toContain("WDJB-MJHT");
});

test("an unattended run installs the configured token on the workspace and reports the credential connected", async () => {
  const events = capturedEvents();
  const workspace = new FakeTenantWorkspace();
  const name = "credential-surfaces-configured-token";

  const status = await runInDurableObject(
    env.SUPERVISOR.getByName(name),
    async (_instance, state) => {
      const { github } = tenantConnections(state.storage, name, workspace, {
        clientId: undefined,
        fallbackToken: FAKE_TOKEN,
        fetcher: githubReplying(),
      });

      await Effect.runPromise(github.ensureCredential(NOW));

      return github.lastKnown(NOW);
    },
  );

  expect(status.github).toMatchObject({ state: "connected" });
  expectTokenOnlyOnInstallStdin(workspace);
  expect(named(events(), "github-credential.install")).toEqual([
    expect.objectContaining({ source: "configured-token" }),
  ]);
  expect(JSON.stringify(events())).not.toContain(FAKE_TOKEN);
});
