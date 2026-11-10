import { REPOSITORY_URL } from "../github.mts";
import type { Fuzzer } from "./context.mts";
import type { Case } from "./http-case.mts";
import { Guard, createGenerator } from "./http-gen.mts";
import type { Environment } from "./http-oracle.mts";
import { QUERIES } from "./http-paths.mts";
import type { Targets } from "./http-routes.mts";
import { Session } from "./http-session.mts";
import { Random } from "./random.mts";

const LANES = 6;

const HUGE_BODIES = 2;

const SCRIPT_PATH = /<script src="([^"]+)"/u;

const VALID = [["authorization", "Basic {valid}"]] as const;

const SETUP_CASES: readonly Case[] = [
  { method: "GET", path: "/health", headers: [], body: undefined, credential: "invalid" },
  { method: "GET", path: "/api/status", headers: [], body: undefined, credential: "invalid" },
  { method: "GET", path: "/api/status", headers: VALID, body: undefined, credential: "valid" },
  {
    method: "POST",
    path: "/api/workspace/backend",
    headers: [...VALID, ["origin", "https://evil.example"]],
    body: { kind: "text", text: '{"backend":"cloudflare"}' },
    credential: "valid",
  },
  {
    method: "POST",
    path: "/api/projects/connect",
    headers: VALID,
    body: { kind: "text", text: "{}" },
    credential: "valid",
  },
];

function queryMatrix(project: string | undefined): readonly Case[] {
  if (project === undefined) return [];

  return ["entries", "events"].flatMap((route) =>
    QUERIES.map((query): Case => ({
      method: "GET",
      path: `/api/projects/${project}/${route}${query}`,
      headers: VALID,
      body: undefined,
      credential: "valid",
    })),
  );
}

export const fuzz: Fuzzer = async (context) => {
  const origin = new URL(context.owner.url).origin;
  const page = await (await context.owner.get("/")).text();
  const scriptPath = SCRIPT_PATH.exec(page)?.[1] ?? "/assets/missing.js";

  const realProject = await context.owner.connect(REPOSITORY_URL).then(
    (id) => {
      context.target.connectedProject = id;

      return id;
    },
    (cause: unknown) => {
      context.log(`no real project: ${String(cause).slice(0, 200)}`);

      return "";
    },
  );

  const targets: Targets = {
    realProject: realProject === "" ? undefined : realProject,
    scriptPath,
  };

  const environment: Environment = {
    ownOrigin: origin,
    scriptPath,
    password: context.password,
    secrets: context.secrets,
  };

  const generator = createGenerator(new Random(context.seed), targets, origin, new Guard(targets), {
    count: HUGE_BODIES,
  });

  const session = new Session({
    area: context.area,
    url: context.owner.url,
    password: context.password,
    environment,
    generator,
    deadlineMs: context.deadlineMs,
    signal: context.signal,
    log: context.log,
  });

  for (const probe of [...SETUP_CASES, ...queryMatrix(targets.realProject)]) {
    await session.record(probe, await session.exchange(probe));
  }

  await Promise.all(Array.from({ length: LANES }, () => session.lane()));
  await session.health("the run");
  context.log(`done: ${session.sent} cases, statuses ${session.statuses()}`);

  return session.findings;
};
