import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import {
  ChatGPTConnection,
  ChatGPTCredentialStore,
  type ChatGPTAccess,
} from "../../src/chatgpt/index.js";
import {
  ACCESS_ONE,
  CLIENT_ID,
  recordingFetch,
  REFRESH_ONE,
  type RecordedCall,
} from "./fixtures.js";
import { AccountEvent, type Grant } from "../../src/chatgpt/account.js";

export const HOUR = 3_600_000;

export type Harness = Readonly<{
  connection: ChatGPTConnection;
  store: ChatGPTCredentialStore;
  calls: RecordedCall[];
  clock: { now: number };
}>;

export function withConnection<T>(
  name: string,
  reply: (call: RecordedCall) => Promise<Response>,
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const clock = { now: 1_000_000 };
    const store = new ChatGPTCredentialStore(state.storage);
    const { fetcher, calls } = recordingFetch(reply);

    const connection = new ChatGPTConnection({
      store,
      fetcher,
      model: "gpt-test",
      clock: () => clock.now,
    });

    return body({ connection, store, calls, clock });
  });
}

export function access(connection: ChatGPTConnection, rejected?: string): Promise<ChatGPTAccess> {
  return Effect.runPromise(connection.access(rejected));
}

export function storeGrant(storage: DurableObjectStorage, grant: Grant, now = Date.now()): void {
  new ChatGPTCredentialStore(storage).update(AccountEvent.LoggedIn({ grant }), now);
}

export function connected(harness: Harness, expiresIn = HOUR): void {
  harness.store.update(
    AccountEvent.LoggedIn({
      grant: {
        accessToken: ACCESS_ONE,
        refreshToken: REFRESH_ONE,
        expiresAt: harness.clock.now + expiresIn,
        clientId: CLIENT_ID,
      },
    }),
    harness.clock.now,
  );
}
