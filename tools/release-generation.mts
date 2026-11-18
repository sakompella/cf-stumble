import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { execute } from "./e2e/process.mts";
import { GENERATION_1_MODULE_MAP, moduleMapSourceFiles } from "./module-map-build.mts";
import {
  releaseOwner,
  type Answer,
  type ApiClient,
  type RequestBody,
} from "./release-generation/owner.mts";
import { releaseGeneration } from "./release-generation/release.mts";

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") throw new Error(`${name} is not set`);

  return value;
}

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });

const url = required("STUMBLE_URL");

const target = required("TARGET_SHA");

const authorization = `Basic ${Buffer.from(`aditya:${required("OWNER_PASSWORD")}`).toString("base64")}`;

const headers = {
  authorization,
  "content-type": "application/json",
  "user-agent": "cf-stumble-release",
  origin: new URL(url).origin,
};

async function answered(response: Promise<Response>): Promise<Answer> {
  const settled = await response;

  return { status: settled.status, text: await settled.text() };
}

function get(path: string): Promise<Answer> {
  return answered(fetch(`${url}${path}`, { headers }));
}

function post(path: string, body: RequestBody, timeoutMs?: number): Promise<Answer> {
  const signal = timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs);

  return answered(
    fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal }),
  );
}

const client: ApiClient = { get, post };

async function facetChangedSince(harnessCommit: string): Promise<boolean> {
  const files = await moduleMapSourceFiles(GENERATION_1_MODULE_MAP);

  const diff = await execute("git", [
    "diff",
    "--quiet",
    harnessCommit,
    target,
    "--",
    "package.json",
    "pnpm-lock.yaml",
    "tools/module-map-build.mts",
    "tools/build-generation-1.mts",
    ...files,
  ]);

  return diff.code !== 0;
}

const summary = await releaseGeneration(target, {
  owner: releaseOwner(client),
  force: values.force,
  facetChangedSince,
  wait: (ms) => sleep(ms),
  now: Date.now,
  report: (line) => {
    console.log(`${new Date().toISOString()} ${line}`);
  },
});

console.log(summary);

const summaryPath = process.env["GITHUB_STEP_SUMMARY"];

if (summaryPath !== undefined)
  await appendFile(summaryPath, `## Generation release\n\n${summary}\n`);
