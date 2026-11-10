import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { without } from "./git-args.js";
import type { GitScope, RunCli } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { rooted, under } from "./git-pathspec.js";
import { failure, OK } from "./git-result.js";
import { fileStatusLines, statusLines } from "./git-status.js";

async function stage(
  client: GitClient,
  dir: string,
  lines: readonly { readonly path: string; readonly y: string }[],
): Promise<void> {
  const pending = lines.filter((line) => line.y !== " ");

  const changed = pending.flatMap((line) =>
    line.y === "D" ? [] : [line.path.replace(/\/$/u, "")],
  );

  const deleted = pending.flatMap((line) => (line.y === "D" ? [line.path] : []));

  if (changed.length > 0) await client.add({ dir, paths: changed });

  if (deleted.length > 0) await client.rm({ dir, paths: deleted });
}

export async function addCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const rest = without(args, ["-u", "--update"]);

  if (rest.length === args.length || rest.some((arg) => arg !== ".")) {
    if (args.some((arg) => arg.startsWith("-"))) return cli(input);

    const specs: string[] = [];

    for (const path of rest) {
      const at = rooted(path, scope.prefix);

      if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

      specs.push(at);
    }

    const lines = await fileStatusLines(client, scope.dir, readFile);
    const matched = lines.filter((line) => specs.some((spec) => under(line.path, spec)));

    const missed = specs.find(
      (spec) => spec !== "." && !matched.some((line) => under(line.path, spec)),
    );

    if (missed !== undefined)
      return failure(`fatal: pathspec '${missed}' did not match any files\n`);

    await stage(client, scope.dir, matched);

    return OK;
  }

  const tracked = (await statusLines(client, scope.dir, readFile)).filter(
    (line) => line.x !== "?" && line.y !== " ",
  );

  await stage(client, scope.dir, tracked);

  return OK;
}
