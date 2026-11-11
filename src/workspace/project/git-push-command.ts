import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { pushDelete } from "./git-push-delete.js";
import { NO_DESTINATION, noUpstream, notARepository, unknownRemote } from "./git-remote-text.js";
import { nonFastForward, pushReport, remoteBranches, type Pushed } from "./git-ref-report.js";
import { resolves } from "./git-revision.js";
import { hasUpstream, upstreamRemote } from "./git-tracking.js";

const UPSTREAM = new Set(["-u", "--set-upstream"]);

const KNOWN_FLAGS = new Set([...UPSTREAM, "-f", "--force", "-d", "--delete"]);

interface PushRequest {
  readonly upstream: boolean;
  readonly remote: string | undefined;
  readonly refspecs: readonly string[];
  readonly deleting: boolean;
}

function pushRequest(args: readonly string[]): PushRequest | undefined {
  const flags = args.filter((arg) => arg.startsWith("-"));

  if (flags.some((flag) => !KNOWN_FLAGS.has(flag))) return undefined;

  const [remote, ...refspecs] = args.filter((arg) => !arg.startsWith("-"));

  return {
    upstream: flags.some((flag) => UPSTREAM.has(flag)),
    remote,
    refspecs,
    deleting:
      flags.includes("-d") ||
      flags.includes("--delete") ||
      refspecs.some((spec) => spec.startsWith(":")),
  };
}

interface Refspec {
  readonly src: string;
  readonly dst: string;
}

function split(refspec: string): Refspec {
  const [src = "", dst] = refspec.replace(/^\+/u, "").split(":");

  return { src, dst: (dst ?? src).replace(/^refs\/heads\//u, "") };
}

async function missingSources(
  client: GitClient,
  dir: string,
  refspecs: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];

  for (const refspec of refspecs) {
    const { src } = split(refspec);

    if (src !== "" && !src.includes("*") && (await resolves(client, dir, src)) === undefined)
      missing.push(src);
  }

  return missing;
}

async function trackUpstream(
  client: GitClient,
  dir: string,
  remote: string,
  refspec: string | undefined,
): Promise<string> {
  const current = await client.currentBranch({ dir });
  const parsed = refspec === undefined ? { src: "HEAD", dst: current ?? "" } : split(refspec);
  const { src } = parsed;
  const dst = src === "HEAD" && refspec?.includes(":") !== true ? (current ?? "") : parsed.dst;
  const branch = src === "HEAD" ? current : src;

  if (branch === undefined || dst === "" || !(await client.branchList({ dir })).includes(branch))
    return "";

  await client.configSet({ dir, path: `branch.${branch}.remote`, value: remote });
  await client.configSet({ dir, path: `branch.${branch}.merge`, value: `refs/heads/${dst}` });

  return `branch '${branch}' set up to track '${remote}/${dst}'.\n`;
}

function pushedRefs(request: PushRequest, branch: string | undefined): Pushed[] {
  if (request.refspecs.length === 0)
    return branch === undefined || request.deleting ? [] : [{ from: branch, to: branch }];

  return request.refspecs
    .map((refspec) => {
      const { src, dst } = split(refspec);
      const head = src === "HEAD" && !refspec.includes(":");

      return { from: src.replace(/^refs\/heads\//u, ""), to: head ? (branch ?? dst) : dst };
    })
    .filter(({ to }) => !to.startsWith("refs/"));
}

interface PushTarget {
  readonly name: string;
  readonly url: string;
  readonly branch: string | undefined;
}

async function reportedPush(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  files: WorkFiles,
  dir: string,
  request: PushRequest,
  target: PushTarget,
): Promise<GitCliResult> {
  const before = await remoteBranches(client, files, dir, target.name);
  const result = await cli(input);

  if (result.exitCode !== 0) return result;

  const after = await remoteBranches(client, files, dir, target.name);
  const forced = await nonFastForward(client, dir, before, after);

  const report = pushReport(target.url, pushedRefs(request, target.branch), {
    before,
    after,
    forced,
  });

  return { ...result, stderr: `${result.stderr}${report}` };
}

export async function pushCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const request = pushRequest(input.argv.slice(1));
  const dir = scope.dir;

  if (request === undefined) return cli(pushDelete(input));

  const remotes = await client.remoteList({ dir });
  const { remote, refspecs } = request;

  const target = remote ?? remotes.find((known) => known.name === "origin")?.name;

  if (target === undefined) return remotes.length === 0 ? NO_DESTINATION : cli(pushDelete(input));

  const branch = await client.currentBranch({ dir });

  const pushTo = (name: string, sent: GitCliInput = pushDelete(input)): Promise<GitCliResult> => {
    const url = remotes.find((known) => known.name === name)?.url;

    return url === undefined
      ? cli(sent)
      : reportedPush(client, cli, sent, files, dir, request, { name, url, branch });
  };

  if (
    refspecs.length === 0 &&
    !request.deleting &&
    branch !== undefined &&
    !(await hasUpstream(client, dir, branch))
  )
    return noUpstream(target, branch);

  if (remote === undefined) {
    const named =
      (branch === undefined ? undefined : await upstreamRemote(client, dir, branch)) ?? target;

    return pushTo(named);
  }

  const missing = request.deleting ? [] : await missingSources(client, dir, refspecs);

  if (missing.length > 0) {
    const shown = remotes.find((known) => known.name === remote)?.url ?? remote;

    return {
      stdout: "",
      stderr: `${missing.map((src) => `error: src refspec ${src} does not match any\n`).join("")}error: failed to push some refs to '${shown}'\n`,
      exitCode: 1,
    };
  }

  if (unknownRemote(remotes, remote)) return notARepository(remote);

  const forwarded = { ...input, argv: input.argv.filter((arg) => !UPSTREAM.has(arg)) };
  const result = await pushTo(remote, pushDelete(forwarded));

  if (result.exitCode !== 0 || !request.upstream || request.deleting) return result;

  if (!remotes.some((known) => known.name === remote)) return result;

  return { ...result, stdout: await trackUpstream(client, dir, remote, refspecs[0]) };
}
