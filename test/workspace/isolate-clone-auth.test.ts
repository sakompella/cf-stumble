import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { cloneIntoPlace } from "../../src/workspace/isolate-clone.js";

const TOKEN = "ghp_cloneTokenMustStayOnGitHub0123456789";

async function headersSentTo(url: string): Promise<Record<string, string> | undefined> {
  let headers: Record<string, string> | undefined = undefined;

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
            headers = input.headers;

            return Promise.resolve();
          },
          configSet: () => Promise.resolve(),
        },
      },
      { url, root: "/workspace/project", depth: 1, token: TOKEN },
    ),
  );

  return headers;
}

test("an isolate clone sends the token to github.com and to no other remote", async () => {
  expect(await headersSentTo("https://github.com/owner/repo")).toEqual({
    Authorization: `Basic ${btoa(`x-access-token:${TOKEN}`)}`,
  });
  expect(await headersSentTo("https://git.example.com/owner/repo.git")).toEqual({});
  expect(await headersSentTo("https://github.com.example.com/owner/repo.git")).toEqual({});
  expect(await headersSentTo("http://github.com/owner/repo.git")).toEqual({});
});
