import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { projectCloneSource } from "../../src/project-provision.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  FLOCK_STAND_IN,
  STUB_GIT,
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "./planned-shell-fixture.js";

const scratch = scratchDirectory("cf-stumble-origin-");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a clone whose existing directory has another origin fails and says why", () => {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(scratch, "tmp"));
  writeExecutable(join(bin, "git"), STUB_GIT);
  writeExecutable(join(bin, "flock"), FLOCK_STAND_IN);
  writeFileSync(join(scratch, "existing-clone"), "");

  const source = projectCloneSource(sampleProjectOne);

  const ran = spawnSync("/bin/sh", ["-c", underScratch(source, scratch)], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      STUB_DIR: scratch,
      STUB_REMOTE: "https://github.com/someone/else",
    },
  });

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain("origin");
});
