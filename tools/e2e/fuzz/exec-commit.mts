import { Buffer } from "node:buffer";
import * as Schema from "effect/Schema";
import { REPOSITORY } from "../github.mts";

const Sha = Schema.Struct({ sha: Schema.String });

const Commit = Schema.Struct({ tree: Sha });

const Contents = Schema.Struct({ content: Schema.String });

const FACET_FILE = "src/facet/generation-1/fuzz-exec.ts";

type Edits = ReadonlyArray<readonly [string, string]>;

const FACET_PATCHES: ReadonlyMap<string, Edits> = new Map([
  [
    "src/facet/generation-1/open-session.ts",
    [
      [
        'import { ROUTE_MODEL, routeProvider } from "./route-provider.js";',
        'import { fuzzModel } from "./fuzz-exec.js";\nimport { ROUTE_MODEL, routeProvider } from "./route-provider.js";',
      ],
      ["routeProvider(input.model, log)", "routeProvider(fuzzModel(input.model), log)"],
    ],
  ],
  [
    "src/facet/generation-1/registry.ts",
    [
      [
        'import { CodingTools } from "./coding-tools.js";',
        'import { CodingTools } from "./coding-tools.js";\nimport { FuzzTools } from "./fuzz-exec.js";',
      ],
      [
        "registry.install(CodingTools);",
        "registry.install(CodingTools);\n  registry.install(FuzzTools);",
      ],
    ],
  ],
]);

export const PATCHED_FACET_FILES: readonly string[] = [...FACET_PATCHES.keys()];

export function patchFacetFile(path: string, source: string): string {
  const edits = FACET_PATCHES.get(path);

  if (edits === undefined) throw new Error(`the exec fuzzer has no patch for ${path}`);

  return edits.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`${path} no longer contains ${from}`);

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
    body?: Schema.Json,
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

    const patched = await Promise.all(
      PATCHED_FACET_FILES.map(async (path) => {
        const file = await this.#call("GET", `/contents/${path}?ref=${base}`, Contents);

        return {
          path,
          mode: "100644",
          type: "blob",
          content: patchFacetFile(path, Buffer.from(file.content, "base64").toString("utf8")),
        };
      }),
    );

    const tree = await this.#call("POST", "/git/trees", Sha, {
      base_tree: parent.tree.sha,
      tree: [...patched, { path: FACET_FILE, mode: "100644", type: "blob", content: facetSource }],
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
