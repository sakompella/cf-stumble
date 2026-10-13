import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bidiListeningUrl,
  isApprovalText,
  isCallbackUrl,
  isSessionStorage,
  isSessionFile,
  matchesAccount,
  parseOptions,
  redactPageText,
} from "./options.mts";

await test("arguments reject unsafe origins and invalid timeouts", () => {
  const required = ["--profile", "/profile", "--origin", "https://example.com"];

  const options = parseOptions([
    "--inspect",
    "--headed",
    ...required,
    "--origin",
    "https://example.com/",
    "--timeout-ms",
    "2500",
  ]);

  assert.equal(options.origin, "https://example.com");
  assert.equal(options.timeoutMs, 2500);
  assert.equal(options.inspect, true);
  assert.equal(options.headed, true);
  assert.equal(parseOptions(required).headed, false);
  assert.equal(parseOptions(["--inspect", "--profile", "/profile"]).origin, "");

  for (const origin of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?code=secret",
  ]) {
    assert.throws(() => parseOptions(["--profile", "/profile", "--origin", origin]));
  }

  for (const timeout of ["0", "-1", "NaN", "1.5", "Infinity"]) {
    assert.throws(() => parseOptions([...required, "--timeout-ms", timeout]));
  }

  assert.throws(() => parseOptions(["--origin", "https://example.com"]));
  assert.throws(() => parseOptions(["--profile", "/profile"]));
  assert.throws(() => parseOptions(["--profile"]));
  assert.throws(() => parseOptions([...required, "--unknown", "value"]));
});

await test("BiDi line parser reads only loopback endpoints amid Firefox noise", () => {
  assert.equal(
    bidiListeningUrl("warning\nWebDriver BiDi listening on ws://127.0.0.1:43123\n"),
    "ws://127.0.0.1:43123",
  );
  assert.equal(
    bidiListeningUrl("WebDriver BiDi listening on ws://[::1]:41234/session\n"),
    "ws://[::1]:41234/session",
  );
  assert.equal(bidiListeningUrl("WebDriver BiDi listening on ws://example.com:1234"), undefined);
  assert.equal(bidiListeningUrl("DevTools listening on ws://127.0.0.1:1234"), undefined);
});

await test("callback match excludes other hosts, ports, and paths regardless of query", () => {
  for (const query of ["", "?code=private&state=private", "?error=access_denied"]) {
    assert.equal(isCallbackUrl(`http://127.0.0.1:1455/auth/callback${query}`), true);
  }

  for (const url of [
    "http://localhost:1455/auth/callback",
    "http://127.0.0.1:1456/auth/callback",
    "https://127.0.0.1:1455/auth/callback",
    "http://127.0.0.1:1455/auth/callback/",
    "http://user@127.0.0.1:1455/auth/callback",
    "not a URL",
  ]) {
    assert.equal(isCallbackUrl(url), false);
  }
});

await test("profile filter includes session origins but not lookalike domains", () => {
  for (const host of ["auth.openai.com", "chatgpt.com", "openai.com"]) {
    for (const suffix of ["", "+idb", "^userContextId=1"]) {
      assert.equal(isSessionStorage(`https+++${host}${suffix}`), true);
    }

    assert.equal(isSessionStorage(`https+++${host}.evil.com`), false);
    assert.equal(isSessionStorage(`http+++${host}`), false);
  }
});

await test("approval matcher excludes cancellation and unrelated continuation words", () => {
  for (const label of [
    "Continue",
    " Allow access ",
    "AUTHORIZE",
    "Approve cf-stumble",
    "Accept and continue",
  ]) {
    assert.equal(isApprovalText(label), true);
  }

  for (const label of [
    "Cancel",
    "Do not allow",
    "Disapprove",
    "Continued",
    "Use another account",
  ]) {
    assert.equal(isApprovalText(label), false);
  }
});

await test("diagnostics strip query strings and token-like text before truncation", () => {
  const text = redactPageText(
    "Visit https://auth.openai.com/callback?code=secret&state=hidden eyJprivate sk-private refresh_token=private",
  );

  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("hidden"), false);
  assert.equal(text.includes("private"), false);
  assert.equal(redactPageText("a".repeat(9000)).length, 8000);
});

await test("session files exclude bulk browser data and profile locks", () => {
  for (const file of [
    "cookies.sqlite",
    "cookies.sqlite-wal",
    "cookies.sqlite-shm",
    "cert9.db",
    "key4.db",
    "pkcs11.txt",
  ]) {
    assert.equal(isSessionFile(file), true);
  }

  for (const file of [
    "places.sqlite",
    "prefs.js",
    "parent.lock",
    "logins.json",
    "cookies.sqlite.bak",
  ]) {
    assert.equal(isSessionFile(file), false);
  }
});

await test("account names match whole labels rather than substrings", () => {
  assert.equal(matchesAccount("Account Person", ["Account", "Person"], "person"), true);
  assert.equal(matchesAccount("Account Person", ["Account", "Person"], "per"), false);
  assert.equal(matchesAccount("Account Person", ["Account", "Person"], "someone else"), false);
  assert.equal(matchesAccount("Account Person", ["Account", "Person"], ""), true);
});
