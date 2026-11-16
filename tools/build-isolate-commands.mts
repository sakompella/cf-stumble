import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JUST_BASH_COMMAND_NAMES } from "./just-bash-commands.mts";

const repoRoot = resolve(import.meta.dirname, "..");

const OUTPUT_PATH = "src/workspace/project/isolate-commands.generated.ts";

await writeFile(
  resolve(repoRoot, OUTPUT_PATH),
  `export type IsolateCommandName = ${JUST_BASH_COMMAND_NAMES.map((name) => JSON.stringify(name)).join(" | ")};\n`,
);

console.log(`Wrote ${OUTPUT_PATH}: ${String(JUST_BASH_COMMAND_NAMES.length)} commands`);
