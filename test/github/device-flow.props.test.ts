import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { parseGitHubToken } from "../../src/github/index.js";

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
