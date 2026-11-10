import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const computerPackage = resolve(
  import.meta.dirname,
  "../node_modules/@cloudflare/computer/package.json",
);

const SCRIPT = `
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(realpathSync(${JSON.stringify(computerPackage)}));
const { Bash } = await import(require.resolve("just-bash"));
const { files, commands } = JSON.parse(process.argv[1]);
const results = [];
for (const command of commands) {
  const bash = new Bash({
    files: Object.fromEntries(Object.entries(files).map(([path, text]) => ["/w/" + path, text])),
    cwd: "/w",
  });
  const { stdout, exitCode } = await bash.exec(command);
  results.push({ stdout, exitCode });
}
console.log(JSON.stringify(results));
`;

const Results = Schema.Array(Schema.Struct({ stdout: Schema.String, exitCode: Schema.Number }));

const decodeResults = Schema.decodeUnknownSync(Schema.fromJsonString(Results));

export type ShellOutput = Readonly<{ stdout: string; exitCode: number }>;

export function justBashOutputs(
  files: Readonly<Record<string, string>>,
  commands: readonly string[],
): readonly ShellOutput[] {
  const payload = JSON.stringify({ files, commands });

  return decodeResults(
    execFileSync(process.execPath, ["--input-type=module", "-e", SCRIPT, payload], {
      encoding: "utf8",
    }),
  );
}
