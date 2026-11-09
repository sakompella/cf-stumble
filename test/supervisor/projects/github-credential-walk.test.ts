import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  CredentialEvent,
  type CredentialEvent as Event,
} from "../../../src/supervisor/projects/github-connection-machine.js";
import { GitHubConnectionStore } from "../../../src/supervisor/projects/github-connection-store.js";

afterEach(async () => {
  await reset();
});

const events: readonly Event[] = [
  CredentialEvent.Observed({
    answer: { state: "connected", login: "octocat" },
    installedBy: "device-authorization",
    now: 1,
  }),
  CredentialEvent.Observed({
    answer: { state: "connected", login: undefined },
    installedBy: undefined,
    now: 2,
  }),
  CredentialEvent.Observed({
    answer: { state: "missing", login: undefined },
    installedBy: undefined,
    now: 3,
  }),
  CredentialEvent.Observed({
    answer: { state: "unusable", login: undefined },
    installedBy: undefined,
    now: 4,
  }),
  CredentialEvent.Observed({
    answer: { state: "tooling-missing", login: undefined },
    installedBy: undefined,
    now: 5,
  }),
  CredentialEvent.WorkspaceUnreachable({ now: 6 }),
  CredentialEvent.InstallRefused({ reason: "credential-rejected", now: 7 }),
];

function sequences(depth: number): readonly (readonly Event[])[] {
  return depth === 0
    ? [[]]
    : sequences(depth - 1).flatMap((prefix) => events.map((event) => [...prefix, event]));
}

test("every stored credential reads back as the state the transition produced", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("credential-walk"), (_instance, state) => {
    const store = new GitHubConnectionStore(state.storage);

    for (const sequence of sequences(3)) {
      store.clear();

      for (const event of sequence) {
        const next = store.applyCredential(store.revision(), event);

        expect(store.credential()).toEqual(next);
      }
    }
  });
});
