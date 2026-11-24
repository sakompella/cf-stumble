import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const repoRoot = resolve(import.meta.dirname, "..");

const OUTPUT_PATH = "src/workspace/project/isolate-commands.generated.ts";

const computerPackage = resolve(repoRoot, "node_modules/@cloudflare/computer/package.json");

const SCRIPT = `
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(realpathSync(${JSON.stringify(computerPackage)}));
const { getCommandNames } = await import(require.resolve("just-bash"));
console.log(JSON.stringify(getCommandNames()));
`;

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const names = decodeNames(
  execFileSync(process.execPath, ["--input-type=module", "-e", SCRIPT], { encoding: "utf8" }),
);

await writeFile(
  resolve(repoRoot, OUTPUT_PATH),
  `export type IsolateCommandName = ${names.map((name) => JSON.stringify(name)).join(" | ")};\n`,
);

console.log(`Wrote ${OUTPUT_PATH}: ${String(names.length)} commands`);
