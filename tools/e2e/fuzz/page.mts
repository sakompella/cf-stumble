import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPOSITORY_URL } from "../github.mts";
import { execute } from "../process.mts";
import type { Finding, Fuzzer } from "./context.mts";
import { firstViolations } from "./page-trace.mts";

const SPEC_DIR = join(import.meta.dirname, "page");

const ROUND_MINUTES = 10;

const MAX_SENDS_PER_ROUND = 6;

function writeSpec(seed: number): string {
  const directory = join(tmpdir(), `cf-stumble-page-fuzz-${seed}`);

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  cpSync(SPEC_DIR, directory, { recursive: true });
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ seed, maxSends: MAX_SENDS_PER_ROUND }),
  );

  return directory;
}

function chromiumEnv(): NodeJS.ProcessEnv {
  const chromium = process.env["CHROMIUM_PATH"];
  const path = chromium === undefined ? "" : `${dirname(chromium)}:`;

  return { ...process.env, PATH: `${path}${process.env["PATH"] ?? ""}` };
}

type Round = Readonly<{ seed: number; seconds: number; url: string; header: string }>;

type Played = Readonly<{
  spec: string;
  code: number;
  output: string;
  violations: ReturnType<typeof firstViolations>;
}>;

async function playRound({ seed, seconds, url, header }: Round): Promise<Played> {
  const spec = writeSpec(seed);
  const outputPath = join(spec, "run");

  const { code, output } = await execute(
    "pnpm",
    [
      "exec",
      "bombadil",
      "browser",
      "test",
      "--headless",
      "--no-sandbox",
      "--time-limit",
      `${seconds}s`,
      "--header",
      header,
      "--output-path",
      outputPath,
      url,
      join(spec, "spec.ts"),
    ],
    { env: chromiumEnv() },
  );

  return { spec, code, output, violations: firstViolations(outputPath) };
}

export const fuzz: Fuzzer = async ({
  area,
  seed,
  deadlineMs,
  signal,
  owner,
  password,
  target,
  secrets,
  log,
}) => {
  const findings: Finding[] = [];
  const header = `Authorization=Basic ${Buffer.from(`aditya:${password}`).toString("base64")}`;

  const scrub = (text: string) =>
    secrets.reduce((kept, secret) => kept.replaceAll(secret, "<secret>"), text);

  target.connectedProject = await owner.connect(REPOSITORY_URL);

  for (let round = 0; !signal.aborted; round += 1) {
    const secondsLeft = Math.floor((deadlineMs - Date.now()) / 1000);

    if (secondsLeft < 60) break;

    const roundSeed = seed + round;
    const seconds = Math.min(secondsLeft, ROUND_MINUTES * 60);

    log(`round ${round}, seed ${roundSeed}, ${seconds} s`);

    const played = await playRound({ seed: roundSeed, seconds, url: owner.url, header });

    log(`round ${round} exited ${played.code}, ${played.violations.length} violated properties`);

    if (played.violations.length === 0 && played.code !== 0) {
      throw new Error(`bombadil exited ${played.code}: ${scrub(played.output.slice(-1500))}`);
    }

    for (const { property, detail } of played.violations) {
      findings.push({
        area,
        oracle: property,
        detail: scrub(detail),
        reproduction: `pnpm e2e:fuzz --area page --seed ${roundSeed} --minutes ${ROUND_MINUTES} (trace kept in ${played.spec})`,
      });
    }

    if (played.violations.length === 0) rmSync(played.spec, { recursive: true, force: true });
  }

  return findings;
};
