import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { AccountEvent, type Grant } from "./account.js";

export const SignIn = Schema.TaggedUnion({
  idle: {},
  pending: {
    attemptId: Schema.String,
    state: Schema.String,
    verifier: Schema.String,
    authorizeUrl: Schema.String,
    expiresAt: Schema.Number,
  },
  exchanging: { attemptId: Schema.String },
});

export type SignIn = typeof SignIn.Type;

type PendingSignIn = typeof SignIn.cases.pending.Type;

export type SignInEvent = Data.TaggedEnum<{
  Started: { readonly attempt: Omit<PendingSignIn, "_tag"> };
  Lapsed: { readonly attemptId: string };
  Redeemed: { readonly attemptId: string };
  Failed: { readonly attemptId: string };
  Exchanged: { readonly attemptId: string; readonly grant: Grant };
  Cancelled: object;
}>;

export const SignInEvent = Data.taggedEnum<SignInEvent>();

export type SignInStep = Readonly<{ signIn: SignIn; account: AccountEvent | null }>;

export type Redemption = Data.TaggedEnum<{
  Unknown: object;
  Expired: object;
  Redeem: { readonly pending: PendingSignIn };
}>;

export const Redemption = Data.taggedEnum<Redemption>();

const IDLE = SignIn.cases.idle.make({});

function stay(signIn: SignIn): SignInStep {
  return { signIn, account: null };
}

function whenPending(
  signIn: SignIn,
  attemptId: string,
  next: (pending: PendingSignIn) => SignIn,
): SignInStep {
  return SignIn.match(signIn, {
    idle: stay,
    exchanging: stay,
    pending: (pending) => stay(pending.attemptId === attemptId ? next(pending) : pending),
  });
}

function whenExchanging(signIn: SignIn, attemptId: string, account: AccountEvent | null) {
  return SignIn.match(signIn, {
    idle: stay,
    pending: stay,
    exchanging: (exchanging): SignInStep =>
      exchanging.attemptId === attemptId ? { signIn: IDLE, account } : stay(exchanging),
  });
}

export function signInTransition(signIn: SignIn, event: SignInEvent): SignInStep {
  return SignInEvent.$match(event, {
    Started: ({ attempt }) => stay(SignIn.cases.pending.make(attempt)),
    Lapsed: ({ attemptId }) => whenPending(signIn, attemptId, () => IDLE),
    Redeemed: ({ attemptId }) =>
      whenPending(signIn, attemptId, () => SignIn.cases.exchanging.make({ attemptId })),
    Failed: ({ attemptId }) => whenExchanging(signIn, attemptId, null),
    Exchanged: ({ attemptId, grant }) =>
      whenExchanging(signIn, attemptId, AccountEvent.LoggedIn({ grant })),
    Cancelled: () => ({ signIn: IDLE, account: AccountEvent.Disconnected() }),
  });
}

export function decideRedemption(signIn: SignIn, attemptId: string, now: number): Redemption {
  return SignIn.match(signIn, {
    idle: () => Redemption.Unknown(),
    exchanging: () => Redemption.Unknown(),
    pending: (pending) => {
      if (pending.attemptId !== attemptId) return Redemption.Unknown();

      return pending.expiresAt <= now ? Redemption.Expired() : Redemption.Redeem({ pending });
    },
  });
}
