import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { cloneIntoPlace } from "../../src/workspace/isolate-clone.js";

const GITHUB_HOSTS = ["github.com", "GitHub.COM", "github.com:443"];

const OTHER_HOSTS = [
  "github.com.",
  "github.com:8443",
  "github.com.example.com",
  "evilgithub.com",
  "api.github.com",
  "git.example.com",
];

async function headersSentTo(url: string, token: string): Promise<Record<string, string>> {
  const sent: Record<string, string>[] = [];

  await Effect.runPromise(
    cloneIntoPlace(
      {
        fs: {
          rm: () => Promise.resolve(),
          mkdir: () => Promise.resolve(),
          rename: () => Promise.resolve(),
        },
        git: {
          clone: (input) => {
            sent.push(input.headers ?? {});

            return Promise.resolve();
          },
          configSet: () => Promise.resolve(),
        },
      },
      { url, root: "/workspace/project", depth: 1, token },
    ),
  );

  return sent[0] ?? {};
}

test("an isolate clone sends the token to https github.com and to no other remote", () =>
  hegel.testAsync(async (tc) => {
    const scheme = tc.draw(gs.sampledFrom(["https", "http", "ssh", "git"]));
    const userinfo = tc.draw(gs.sampledFrom(["", "user@", "github.com@", "x:y@"]));
    const host = tc.draw(gs.sampledFrom([...GITHUB_HOSTS, ...OTHER_HOSTS]));

    const path = tc.draw(
      gs.arrays(gs.sampledFrom(["owner", "repo.git", "@", ".."]), { maxSize: 3 }),
    );

    const token = tc.draw(gs.fromRegex("[A-Za-z0-9_]{1,40}"));
    const url = `${scheme}://${userinfo}${host}/${path.join("/")}`;
    const toGitHub = scheme === "https" && GITHUB_HOSTS.includes(host);

    const headers = await headersSentTo(url, token);

    if (!toGitHub) {
      expect(headers).toEqual({});

      return;
    }

    expect(Object.keys(headers)).toEqual(["Authorization"]);
    expect(atob((headers["Authorization"] ?? "").replace(/^Basic /u, ""))).toBe(
      `x-access-token:${token}`,
    );
  }));
