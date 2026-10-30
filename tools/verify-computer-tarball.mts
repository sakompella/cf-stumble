import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * A matching digest proves the vendored Computer tarball is the recorded blob.
 * `scripts/vendor/verify-computer-tarball.sh` rebuilds it from upstream to show where it came from.
 */

const tarball = resolve(import.meta.dirname, "../vendor/cloudflare-computer-0.3.0.tgz");

const recorded = await readFile(`${tarball}.sha256`, "utf8");

const expected = /^(?<hash>[a-f0-9]{64})  cloudflare-computer-0\.3\.0\.tgz\n$/u.exec(recorded)
  ?.groups?.hash;

if (expected === undefined) throw new Error("Invalid vendor/cloudflare-computer-0.3.0.tgz.sha256");

const actual = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");

if (actual !== expected)
  throw new Error("SHA256 mismatch for vendor/cloudflare-computer-0.3.0.tgz");
