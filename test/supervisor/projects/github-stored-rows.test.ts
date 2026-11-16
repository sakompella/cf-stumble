import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { GitHubConnectionStore } from "../../../src/supervisor/projects/github-connection-store.js";
import { ownerSession } from "../../integration/owner-session.js";

afterEach(async () => {
  await reset();
});

type StoredCheck = Readonly<{
  state: string;
  reason: string | null;
  login: string | null;
  source: string | null;
}>;

async function connectionAnswerFor(
  check: StoredCheck,
  connectionSource: string | null,
): Promise<{ status: number; github: unknown }> {
  const { supervisor } = ownerSession();

  await runInDurableObject(supervisor, (_instance, state) => {
    expect(new GitHubConnectionStore(state.storage).credential()._tag).toBe("unchecked");

    state.storage.sql.exec(
      `INSERT INTO github_connection_check
         (id, state, reconnect_reason, login, credential_source, checked_at)
       VALUES (1, ?, ?, ?, ?, 1700000000000)`,
      check.state,
      check.reason,
      check.login,
      check.source,
    );

    if (connectionSource !== null)
      state.storage.sql.exec(
        `INSERT INTO github_connection (id, login, credential_source, connected_at)
         VALUES (1, 'octocat', ?, 1699999999000)`,
        connectionSource,
      );
  });

  const response = await ownerSession().get("/api/github/connection");
  const body = await response.json<{ github: unknown }>();

  return { status: response.status, github: body.github };
}

test("a stored reconnect reason this Worker does not know reads as a rejected credential instead of failing the connection answer", async () => {
  const answer = await connectionAnswerFor(
    { state: "reconnect-required", reason: "quota-exceeded", login: null, source: null },
    null,
  );

  expect(answer).toEqual({
    status: 200,
    github: { state: "reconnect-required", reason: "credential-rejected" },
  });
});

test("a reconnect-required row with no stored reason reads as a rejected credential", async () => {
  const answer = await connectionAnswerFor(
    { state: "reconnect-required", reason: null, login: null, source: null },
    null,
  );

  expect(answer.github).toEqual({ state: "reconnect-required", reason: "credential-rejected" });
});

test("a connected row whose credential source this Worker does not know still reports the login, with the default source", async () => {
  const answer = await connectionAnswerFor(
    { state: "connected", reason: null, login: "octocat", source: "oauth-app" },
    "oauth-app",
  );

  expect(answer).toEqual({
    status: 200,
    github: { state: "connected", login: "octocat", source: "device-authorization" },
  });
});

test("a missing-tooling row keeps answering when the recorded connection beside it has an unknown source", async () => {
  const answer = await connectionAnswerFor(
    { state: "tooling-missing", reason: null, login: null, source: null },
    "oauth-app",
  );

  expect(answer).toEqual({ status: 200, github: { state: "tooling-missing" } });
});
