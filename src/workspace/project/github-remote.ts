import { Buffer } from "node:buffer";

const GITHUB_HOST = "github.com";

const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;

const HOST_LINE = /^(\S+):\s*$/u;

const TOKEN_LINE = /^\s+oauth_token:\s*(\S+)\s*$/u;

export function githubTokenFromHosts(hosts: string): string | undefined {
  let host: string | undefined = undefined;

  for (const line of hosts.split("\n")) {
    const entry = HOST_LINE.exec(line);

    if (entry !== null) host = entry[1];
    else if (host === GITHUB_HOST) {
      const token = TOKEN_LINE.exec(line)?.[1];

      if (token !== undefined) return token;
    }
  }

  return undefined;
}

export function isGitHubRemote(url: string): boolean {
  try {
    return new URL(url).origin === GITHUB_ORIGIN;
  } catch {
    return false;
  }
}

export function githubCloneHeaders(url: string, token: string | undefined) {
  if (token === undefined || !isGitHubRemote(url)) return {};

  return {
    Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}
