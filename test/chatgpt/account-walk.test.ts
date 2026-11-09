import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { AccountEvent, ChatGPTAccount, transition } from "../../src/chatgpt/account.js";
import { ChatGPTCredentialStore } from "../../src/chatgpt/index.js";

afterEach(async () => {
  await reset();
});

const grantOf = (name: string) => ({
  accessToken: `access-${name}`,
  refreshToken: `refresh-${name}`,
  expiresAt: 5_000,
  clientId: "client",
});

const EVENTS: readonly AccountEvent[] = [
  AccountEvent.LoggedIn({ grant: grantOf("a") }),
  AccountEvent.Refreshed({ redeemed: "refresh-a", grant: grantOf("b") }),
  AccountEvent.RefreshRefused({ accessToken: "access-a", reason: "refresh-refused" }),
  AccountEvent.ProviderRefused({ accessToken: "access-b" }),
  AccountEvent.LimitReported({ accessToken: "access-a", reachedAt: 10, limitedUntil: 100 }),
  AccountEvent.LimitReported({ accessToken: "access-b", reachedAt: 20, limitedUntil: null }),
  AccountEvent.LimitLapsed({ now: 50 }),
  AccountEvent.Disconnected(),
];

type Rows = Readonly<{ tokens: readonly unknown[]; limits: number }>;

function rows(storage: DurableObjectStorage): Rows {
  return {
    tokens: storage.sql
      .exec("SELECT access_token, refresh_token, client_id FROM chatgpt_connection")
      .toArray()
      .flatMap((row) => Object.values(row)),
    limits: storage.sql.exec("SELECT 1 FROM chatgpt_usage_limit").toArray().length,
  };
}

function* sequences(depth: number): Generator<readonly AccountEvent[]> {
  yield [];

  if (depth === 0) return;

  for (const rest of sequences(depth - 1)) {
    for (const event of EVENTS) yield [event, ...rest];
  }
}

test("every short event sequence stores what the transition decides, and only a connection keeps tokens or a limit", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("chatgpt-account-walk"), (_instance, state) => {
    const store = new ChatGPTCredentialStore(state.storage);

    for (const events of sequences(3)) {
      let expected = store.update(AccountEvent.Disconnected(), 0);

      for (const event of events) {
        expected = transition(expected, event);
        expect(store.update(event, 1)).toEqual(expected);

        const stored = store.account();
        const written = rows(state.storage);
        expect(stored).toEqual(expected);

        ChatGPTAccount.match(stored, {
          connected: ({ usageLimit }) => {
            expect(written.limits).toBe(usageLimit === null ? 0 : 1);
          },
          disconnected: () => {
            expect(written).toEqual({ tokens: [], limits: 0 });
          },
          needsReconnect: () => {
            expect(written).toEqual({ tokens: ["", "", ""], limits: 0 });
          },
        });
      }
    }
  });
});
