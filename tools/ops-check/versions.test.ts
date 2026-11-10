import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonRecord } from "../json.mts";
import {
  parseLatestDeployment,
  parseStaleCalls,
  versionFindings,
  type StaleCall,
  type VersionInput,
} from "./versions.mts";

const DEPLOYED = Date.parse("2026-10-01T12:00:00Z");

const NEW_VERSION = "61f8dbef-ce17-45f0-96aa-2983628bd8e8";

const OLD_VERSION = "d3670911-5aaa-4f1b-8d1e-0123456789ab";

const deployment = (createdOn: string, versionId: string): JsonRecord => ({
  created_on: createdOn,
  versions: [{ version_id: versionId, percentage: 100 }],
});

const row = (entrypoint: string, timestamp: number): JsonRecord => ({
  timestamp,
  $workers: { entrypoint, scriptVersion: { id: OLD_VERSION } },
});

const stale = (durableObject: string, minutesAfter: number): StaleCall => ({
  durableObject,
  atMs: DEPLOYED + minutesAfter * 60_000,
  version: OLD_VERSION,
});

const input = (staleCalls: readonly StaleCall[]): VersionInput => ({
  worker: "cf-stumble",
  nowMs: DEPLOYED + 60 * 60_000,
  state: {
    status: "ok",
    data: { deployment: { deployedAtMs: DEPLOYED, versionIds: [NEW_VERSION] }, staleCalls },
  },
});

describe("parseLatestDeployment", () => {
  it("takes the newest deployment whatever order the list comes in", () => {
    const response = {
      result: {
        deployments: [
          deployment("2026-10-01T10:00:00Z", OLD_VERSION),
          deployment("2026-10-01T12:00:00Z", NEW_VERSION),
        ],
      },
    };

    assert.deepEqual(parseLatestDeployment(response), {
      deployedAtMs: DEPLOYED,
      versionIds: [NEW_VERSION],
    });
  });

  it("refuses an empty list instead of reading it as no skew", () => {
    assert.throws(() => parseLatestDeployment({ result: { deployments: [] } }), /no deployment/u);
  });
});

describe("parseStaleCalls", () => {
  it("reads the class, time and version of each call", () => {
    const response = { result: { events: { events: [row("WorkspaceHost", 5)] } } };

    assert.deepEqual(parseStaleCalls(response), [
      { durableObject: "WorkspaceHost", atMs: 5, version: OLD_VERSION },
    ]);
  });

  it("skips rows without a script version, such as log lines", () => {
    const response = { result: { events: { events: [{ timestamp: 1, source: { event: "x" } }] } } };

    assert.deepEqual(parseStaleCalls(response), []);
  });

  it("refuses a page at the row limit, which may be cut off", () => {
    const page = Array.from({ length: 2000 }, () => row("Supervisor", 1));

    assert.throws(() => parseStaleCalls({ result: { events: { events: page } } }), /rows/u);
  });
});

describe("versionFindings", () => {
  it("passes when no call after the grace ran an older version", () => {
    assert.deepEqual(versionFindings(input([])), []);
  });

  it("names the class, the older version and the span of its calls", () => {
    const [finding, ...rest] = versionFindings(
      input([stale("WorkspaceHost", 6), stale("WorkspaceHost", 9)]),
    );

    assert.equal(rest.length, 0);
    assert.equal(finding?.rule, "do-version-skew");
    assert.match(finding?.detail ?? "", /^WorkspaceHost ran d3670911 in 2 call\(s\)/u);
    assert.match(finding?.detail ?? "", /after the 2026-10-01T12:00Z deployment of 61f8dbef$/u);
  });

  it("reports each class on its own", () => {
    const findings = versionFindings(input([stale("Supervisor", 6), stale("WorkspaceHost", 7)]));

    assert.deepEqual(
      findings.map((finding) => finding.detail.split(" ")[0]),
      ["Supervisor", "WorkspaceHost"],
    );
  });

  it("reports an unavailable source instead of passing", () => {
    const unavailable: VersionInput = {
      worker: "cf-stumble",
      nowMs: DEPLOYED,
      state: { status: "unavailable", reason: "HTTP 403 from /deployments" },
    };

    assert.deepEqual(versionFindings(unavailable), [
      { rule: "unknown", detail: "HTTP 403 from /deployments", evidence: [] },
    ]);
  });
});
