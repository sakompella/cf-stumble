import * as Schema from "effect/Schema";

const REPOSITORY = "sakompella/cf-stumble";

const Ref = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });

const Commit = Schema.Struct({ tree: Schema.Struct({ sha: Schema.String }) });

async function read<S extends Schema.ConstraintDecoder<unknown>>(
  token: string,
  path: string,
  schema: S,
): Promise<S["Type"] | undefined> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "cf-stumble-e2e",
    },
  });

  if (response.status === 404) return undefined;

  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);

  return Schema.decodeUnknownSync(schema)(await response.json());
}

export async function branchTree(token: string, branch: string): Promise<string> {
  const ref = await read(token, `/git/ref/heads/${branch}`, Ref);

  if (ref === undefined) return "absent";

  const commit = await read(token, `/git/commits/${ref.object.sha}`, Commit);

  return commit?.tree.sha ?? "absent";
}
