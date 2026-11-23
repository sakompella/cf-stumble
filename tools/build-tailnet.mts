import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PIN = "5a8acc221f93dc09a1f62b8ab7093153dafe57fa";

const FALLBACK_ROOTS = "golang.org/x/crypto/x509roots/fallback@v0.0.0-20261115193255-739070949446";

const root = resolve(import.meta.dirname, "..");

const output = join(root, "build", "tailnet");

const source = join(output, "source");

function run(command: string, args: string[], cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
  });
}

await mkdir(output, { recursive: true });

try {
  await readFile(join(source, ".git", "HEAD"));
} catch {
  run("git", ["clone", "--no-checkout", "https://github.com/littledivy/tailnet-do", source]);
}

run("git", ["checkout", "--force", PIN], source);

run("sh", ["scripts/apply-patches.sh"], source);

const main = join(source, "go", "main.go");

const original = await readFile(main, "utf8");

const transport =
  "n.httpc = &http.Client{Transport: &http.Transport{DialContext: dialer.UserDial}}";

if (!original.includes(transport)) throw new Error("tailnet-do HTTP client changed");

const imports = 'import (\n\t"bytes"\n';

if (!original.includes(imports)) throw new Error("tailnet-do imports changed");

await writeFile(
  main,
  original
    .replace(
      transport,
      "n.httpc = &http.Client{Transport: &http.Transport{DialContext: dialer.UserDial}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}",
    )
    .replace(imports, `${imports}\t_ "golang.org/x/crypto/x509roots/fallback"\n`),
);

run("go", ["get", FALLBACK_ROOTS], join(source, "go"));

const version = run("go", ["version"]);

if (!version.includes("go1.27.3 ")) throw new Error(`expected Go 1.27.3, got ${version}`);

run("sh", ["scripts/build-wasm.sh"], source);

for (const file of ["index.js", "wasm_exec.js", "tailnet.wasm"]) {
  await cp(join(source, "src", file), join(output, file));
}

const libraryPath = join(output, "index.js");

const library = await readFile(libraryPath, "utf8");

await writeFile(
  libraryPath,
  library
    .replace("let enginePromise = null;", "let enginePromise = null; let engineMemory;")
    .replace(
      "const instance = await WebAssembly.instantiate(engineWasm, go.importObject);",
      "const instance = await WebAssembly.instantiate(engineWasm, go.importObject); engineMemory = instance.exports.mem;",
    )
    .replace(
      "return { ...this.#status, ...this.#node.status() };",
      "return { ...this.#status, ...this.#node.status(), wasmMemoryBytes: engineMemory.buffer.byteLength };",
    ),
);

await cp(join(source, "LICENSE"), join(output, "LICENSE"));

console.error(`Built tailnet-do ${PIN} with ${version.trim()}`);
