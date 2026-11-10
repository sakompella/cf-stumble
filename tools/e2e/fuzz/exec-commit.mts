import { Buffer } from "node:buffer";
import * as Schema from "effect/Schema";
import { REPOSITORY } from "../github.mts";

const Sha = Schema.Struct({ sha: Schema.String });

const Commit = Schema.Struct({ tree: Sha });

const Contents = Schema.Struct({ content: Schema.String });

const OPEN_SESSION = "src/facet/generation-1/open-session.ts";

const FACET_FILE = "src/facet/generation-1/fuzz-exec.ts";

const EDITS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { CodingTools } from "./coding-tools.js";',
    'import { CodingTools } from "./coding-tools.js";\nimport { FuzzTools, fuzzModel } from "./fuzz-exec.js";',
  ],
  ["routeProvider(input.model)", "routeProvider(fuzzModel(input.model))"],
  [
    "registry.install(CodingTools);",
    "registry.install(CodingTools);\n  registry.install(FuzzTools);",
  ],
];

export function patchOpenSession(source: string): string {
  return EDITS.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`open-session.ts no longer contains ${from}`);

    return text.replace(from, to);
  }, source);
}

export class FuzzCommits {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async #call<S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    path: string,
    schema: S,
    body?: typeof Schema.Json.Type,
  ) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      body: body === undefined ? null : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "user-agent": "cf-stumble-e2e",
      },
    });

    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${method} ${path}`);

    return Schema.decodeUnknownSync(schema)(await response.json());
  }

  async branchWithFacet(base: string, branch: string, facetSource: string): Promise<string> {
    const parent = await this.#call("GET", `/git/commits/${base}`, Commit);

    const session = await this.#call("GET", `/contents/${OPEN_SESSION}?ref=${base}`, Contents);

    const patched = patchOpenSession(Buffer.from(session.content, "base64").toString("utf8"));

    const tree = await this.#call("POST", "/git/trees", Sha, {
      base_tree: parent.tree.sha,
      tree: [
        { path: OPEN_SESSION, mode: "100644", type: "blob", content: patched },
        { path: FACET_FILE, mode: "100644", type: "blob", content: facetSource },
      ],
    });

    const commit = await this.#call("POST", "/git/commits", Sha, {
      message: "fuzz: scripted exec model for the exec fuzzer (never merge)",
      tree: tree.sha,
      parents: [base],
    });

    await this.#call("POST", "/git/refs", Schema.Json, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });

    return commit.sha;
  }
}
