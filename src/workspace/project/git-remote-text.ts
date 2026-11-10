import { failure } from "./git-result.js";

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//u;

export const NO_DESTINATION = failure(
  'fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n\nTo push to multiple remotes at once, configure a remote group using\n\n    git config remotes.<groupname> "<remote1> <remote2>"\n\nand then push using the group name\n\n    git push <groupname>\n\n',
);

export function notARepository(remote: string) {
  return failure(
    `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`,
  );
}

export function unknownRemote(
  remotes: readonly { readonly name: string }[],
  word: string,
): boolean {
  return !SCHEME_URL.test(word) && !remotes.some((remote) => remote.name === word);
}

export function noUpstream(remote: string, branch: string) {
  return failure(
    `fatal: The current branch ${branch} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${branch}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n\n`,
  );
}
