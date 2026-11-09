import { Buffer } from "node:buffer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteWorkspaceProvider, Workspace } from "@cloudflare/computer";
import { logRedactedCause } from "../diagnostics.js";
import { resolveGlobalOptions } from "./project/index.js";

const ForwardBody = Schema.Struct({ argv: Schema.Array(Schema.String), cwd: Schema.String });

const decodeForwardBody = Schema.decodeUnknownOption(Schema.fromJsonString(ForwardBody));

type GitForwardResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  gitDir: string | null;
  state: Readonly<Record<string, string>>;
}>;

async function drain(blocks: AsyncIterable<unknown>): Promise<void> {
  for await (const block of blocks) void block;
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBytes(
  provider: SQLiteWorkspaceProvider,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(Buffer.from(await provider.readFile(path)));
  } catch {
    return undefined;
  }
}

async function digestOf(bytes: Uint8Array | undefined): Promise<string> {
  return bytes === undefined ? "" : hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function findGitDir(
  provider: SQLiteWorkspaceProvider,
  start: string,
): Promise<string | undefined> {
  let directory = start;

  for (;;) {
    const gitDir = `${directory === "/" ? "" : directory}/.git`;

    if ((await readBytes(provider, `${gitDir}/HEAD`)) !== undefined) return gitDir;

    if (directory === "/") return undefined;

    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
}

async function gitState(
  provider: SQLiteWorkspaceProvider,
  cwd: string,
): Promise<Pick<GitForwardResult, "gitDir" | "state">> {
  const gitDir = await findGitDir(provider, cwd);

  if (gitDir === undefined) return { gitDir: null, state: {} };

  const head = await readBytes(provider, `${gitDir}/HEAD`);
  const reference = /^ref: (\S+)/u.exec(new TextDecoder().decode(head))?.[1];
  const names = ["HEAD", "index", ...(reference === undefined ? [] : [reference])];

  const entries = await Promise.all(
    names.map(
      async (name) =>
        [name, await digestOf(await readBytes(provider, `${gitDir}/${name}`))] as const,
    ),
  );

  return { gitDir, state: Object.fromEntries(entries) };
}

export async function forwardGit(
  workspace: Workspace,
  backendId: string,
  body: string,
): Promise<Response> {
  const input = decodeForwardBody(body);

  if (Option.isNone(input)) return new Response("expected {argv, cwd}", { status: 400 });

  const resolved = resolveGlobalOptions({ argv: [...input.value.argv], cwd: input.value.cwd });

  if ("failure" in resolved) return Response.json({ ...resolved.failure, gitDir: null, state: {} });

  try {
    await drain(workspace.pull(backendId));

    const result = await workspace.git.cli(resolved.input);

    await drain(workspace.push(backendId));

    const forwarded: GitForwardResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(await gitState(workspace.provider(), resolved.input.cwd ?? "/")),
    };

    return Response.json(forwarded);
  } catch (cause) {
    logRedactedCause("git-forward: internal-error", cause);

    return new Response("git forward failed", { status: 500 });
  }
}
