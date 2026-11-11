import { expect, test } from "vitest";
import { commandProgram } from "../../../src/workspace/project/exec-program.js";

test.each([
  ["git status", "git status"],
  ["git -C repo -c user.name=x commit -m 'token ghp_secret'", "git commit"],
  ["cd repo && git push origin main", "git push"],
  ["git commit -m \"$(cat <<'EOF'\nfix: ship it\nEOF\n)\"", "git commit"],
  ["GH_TOKEN=abc ./scripts/deploy.sh --key secret", "deploy.sh"],
  ["ls -la src | head", "ls"],
  ["git --version", "git"],
  ["echo 'git push --force'", "echo"],
  ['"$HOME/bin/tool" run', "other"],
  ["git 'odd sub'", "git other"],
  ["   ", null],
])("%j is logged as %j", (command, program) => {
  expect(commandProgram(command)).toBe(program);
});
