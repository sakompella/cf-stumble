import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import {
  parseGitHubToken,
  redeemDeviceAuthorization,
  type GitHubFetch,
} from "../../src/github/index.js";

const validToken = gs.fromRegex("[!-~]{8,255}");

const unacceptableCharacter = gs.sampledFrom([
  " ",
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u007F",
  "\u0080",
  "é",
  "\u2028",
]);

test("a token of 8 to 255 printable ASCII characters is accepted unchanged", () => {
  hegel.test((tc) => {
    const token = tc.draw(validToken);

    expect(parseGitHubToken(token)).toBe(token);
  });
});

test("a token with one space, control or non-ASCII character in it is refused", () => {
  hegel.test((tc) => {
    const token = tc.draw(validToken);
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: token.length }));
    const spoiled = `${token.slice(0, at)}${tc.draw(unacceptableCharacter)}${token.slice(at)}`;

    expect(parseGitHubToken(spoiled)).toBeUndefined();
  });
});

test("a token shorter than 8 or longer than 255 characters is refused", () => {
  hegel.test((tc) => {
    const tooShort = tc.draw(gs.fromRegex("[!-~]{0,7}"));
    const tooLong = tc.draw(gs.fromRegex("[!-~]{256,300}"));

    expect(parseGitHubToken(tooShort)).toBeUndefined();
    expect(parseGitHubToken(tooLong)).toBeUndefined();
  });
});

type Sent = string | number | boolean | readonly string[] | null | undefined;

type Field<T> = Readonly<{ sent: Sent; usable: T | undefined }>;

const unsent: Field<never> = { sent: undefined, usable: undefined };

function used<T extends Sent>(value: T): Field<T> {
  return { sent: value, usable: value };
}

function ignored(sent: Sent): Field<never> {
  return { sent, usable: undefined };
}

const tokenField = gs.oneOf(
  gs.just(unsent),
  validToken.map(used),
  gs.fromRegex("[!-~]{0,7}").map(ignored),
  gs.fromRegex("[!-~]{4,10} [!-~]{4,10}").map(ignored),
  gs.sampledFrom([12345678, null, false, ["ghp_abcdefgh"]]).map(ignored),
);

const protocolErrors = ["authorization_pending", "slow_down", "expired_token", "access_denied"];

const errorField = gs.oneOf(
  gs.just(unsent),
  gs.sampledFrom(protocolErrors).map(used),
  gs.text({ maxSize: 20 }).map(used),
  gs.sampledFrom([7, null, true, ["slow_down"]]).map(ignored),
);

const intervalField = gs.oneOf(
  gs.just(unsent),
  gs.integers({ minValue: 1, maxValue: 3600 }).map(used),
  gs.sampledFrom([0, -1, 0.5, 2.5, "7", null]).map(ignored),
);

const answers = new Map([
  ["authorization_pending", { kind: "pending" }],
  ["expired_token", { kind: "expired" }],
  ["access_denied", { kind: "denied" }],
]);

function expectedRedemption(token: Field<string>, error: Field<string>, interval: Field<number>) {
  if (token.usable !== undefined) return { kind: "authorized", token: token.usable };

  if (error.usable === "slow_down") {
    return { kind: "slow-down", intervalSeconds: interval.usable ?? 10 };
  }

  return answers.get(error.usable ?? "") ?? { kind: "unavailable" };
}

function redeemReply(response: Response) {
  const fetcher: GitHubFetch = () => Promise.resolve(response);

  return Effect.runPromise(
    redeemDeviceAuthorization({ clientId: "client", deviceCode: "device-code" }, fetcher),
  );
}

test("a redemption reply means what the OAuth device flow says it means", () =>
  hegel.testAsync(async (tc) => {
    const token = tc.draw(tokenField);
    const error = tc.draw(errorField);
    const interval = tc.draw(intervalField);

    const reply = {
      access_token: token.sent,
      error: error.sent,
      interval: interval.sent,
    };

    await expect(redeemReply(Response.json(reply))).resolves.toEqual(
      expectedRedemption(token, error, interval),
    );
  }));

const notAnAnswer = gs.oneOf(
  gs.sampledFrom([[], "text", 7, null, true, [{ error: "slow_down" }]]).map((body) => ({
    status: 200,
    text: JSON.stringify(body),
  })),
  gs.just({ status: 200, text: "{not json" }),
  gs.sampledFrom([400, 404, 500, 502]).map((status) => ({
    status,
    text: JSON.stringify({ access_token: "ghp_cfstumbleFAKEtoken", error: "access_denied" }),
  })),
);

test("a reply that is no 2xx JSON object is unavailable, whatever it seems to say", () =>
  hegel.testAsync(async (tc) => {
    const { status, text } = tc.draw(notAnAnswer);

    await expect(redeemReply(new Response(text, { status }))).resolves.toEqual({
      kind: "unavailable",
    });
  }));
