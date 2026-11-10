import * as Schema from "effect/Schema";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.ts";

export const HARNESS_REMOTE = HARNESS_BUILD_CONFIGURATION.harnessGitRemote;

const REPOSITORY = new URL(HARNESS_REMOTE).pathname.replace(/^\//u, "").replace(/\.git$/u, "");

export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;

const Refs = Schema.Array(Schema.Struct({ ref: Schema.String }));

const Branch = Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) });

const Contents = Schema.Struct({ content: Schema.String });

export class GitHub {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  #request(method: string, path: string): Promise<Response> {
    return fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "user-agent": "cf-stumble-e2e",
      },
    });
  }

  async #get<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    schema: S,
  ): Promise<S["Type"] | undefined> {
    const response = await this.#request("GET", path);

    if (response.status === 404) return undefined;

    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);

    return Schema.decodeUnknownSync(schema)(await response.json());
  }

  async mainHead(): Promise<string> {
    const main = await this.#get("/branches/main", Branch);

    if (main === undefined) throw new Error("the harness repository has no main branch");

    return main.commit.sha;
  }

  async fileAt(path: string, ref: string): Promise<string | undefined> {
    const body = await this.#get(`/contents/${path}?ref=${encodeURIComponent(ref)}`, Contents);

    return body === undefined ? undefined : Buffer.from(body.content, "base64").toString("utf8");
  }

  async branches(prefix: string): Promise<readonly string[]> {
    const refs = (await this.#get(`/git/matching-refs/heads/${prefix}`, Refs)) ?? [];

    return refs.map(({ ref }) => ref.replace(/^refs\/heads\//u, ""));
  }

  async deleteBranch(branch: string): Promise<void> {
    const response = await this.#request("DELETE", `/git/refs/heads/${branch}`);

    if (!response.ok && response.status !== 422 && response.status !== 404) {
      throw new Error(`GitHub answered ${response.status} deleting ${branch}`);
    }
  }
}
