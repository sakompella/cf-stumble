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
const { getCommandNames } = await import(require.resolve("just-bash"));
console.log(JSON.stringify(getCommandNames()));
`;

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const JUST_BASH_COMMAND_NAMES = decodeNames(
  execFileSync(process.execPath, ["--input-type=module", "-e", SCRIPT], { encoding: "utf8" }),
);
