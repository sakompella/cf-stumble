import { runInDurableObject } from "cloudflare:test";
import { CredentialEvent } from "../../src/supervisor/projects/github-connection-machine.js";
import { GitHubConnectionStore } from "../../src/supervisor/projects/github-connection-store.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

export async function seedGitHubConnection(control: DurableObjectStub<Supervisor>): Promise<void> {
  await runInDurableObject(control, (_instance, state) => {
    const store = new GitHubConnectionStore(state.storage);

    store.applyCredential(
      store.revision(),
      CredentialEvent.Observed({
        answer: { state: "connected", login: "reset-user" },
        installedBy: "configured-token",
        now: 0,
      }),
    );
  });
}
