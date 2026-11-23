import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";

const root = resolve(import.meta.dirname, "..");

const engine = join(root, "build", "tailnet", "source", "go");

const fixtures = join(root, "tools", "tailnet-roots");

function goTest() {
  const overlay = join(root, "build", "tailnet", "roots-overlay.json");

  writeFileSync(
    overlay,
    JSON.stringify({
      Replace: { [join(engine, "roots_test.go")]: join(fixtures, "roots_test.go") },
    }),
  );

  const tags = readFileSync(join(engine, "tags.txt"), "utf8").trim();

  const goroot = execFileSync("go", ["env", "GOROOT"], { cwd: engine, encoding: "utf8" }).trim();

  return spawnSync(
    "go",
    [
      "test",
      "-count=1",
      "-v",
      "-overlay",
      overlay,
      "-tags",
      tags,
      "-exec",
      join(goroot, "lib", "wasm", "go_js_wasm_exec"),
      ".",
    ],
    {
      cwd: engine,
      encoding: "utf8",
      env: {
        HOME: process.env["HOME"],
        PATH: process.env["PATH"],
        CGO_ENABLED: "0",
        GOARCH: "wasm",
        GOOS: "js",
        GOTOOLCHAIN: "local",
        TAILNET_ROOTS_CHAIN: join(fixtures, "hp-chain.pem"),
      },
    },
  );
}

it("the tailnet engine verifies a public certificate chain with its own roots", () => {
  const result = goTest();

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
