// Connects the owner's ChatGPT account to a deployed cf-stumble through the owner API, signing in
// with a temporary copy of a Firefox profile that is already signed in to ChatGPT.
//   pnpm exec tsx tools/chatgpt-connect.mts --origin https://<host> --profile <firefox profile dir>
// --account picks one saved account by email or exact name when the chooser shows several.
// --headed shows the browser window, for when OpenAI refuses the headless sign-in.
// --inspect stops before consent and calls no owner API.
import { ToolError } from "./chatgpt-connect/error.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceHeaders, post } from "./chatgpt-connect/api.mjs";
import { Bidi } from "./chatgpt-connect/bidi.mjs";
import { parseOptions } from "./chatgpt-connect/options.mjs";
import { drivePage } from "./chatgpt-connect/page.mjs";
import { copyProfile, startFirefox, stopFirefox } from "./chatgpt-connect/profile.mjs";

function inspectionUrl(): string {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL("https://auth.openai.com/api/accounts/authorize");

  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    agent_name_hint: "cf-stumble",
    ext_agent_host_id: `urn:uuid:${randomUUID()}`,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:1455/auth/callback",
    resource: "https://api.openai.com/v1",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();

  return url.href;
}

async function browserCallback(
  authorizeUrl: string,
  options: ReturnType<typeof parseOptions>,
  signal: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-profile-"));
  let firefox: ReturnType<typeof startFirefox> | undefined;
  let bidi: Bidi | undefined;

  try {
    await copyProfile(options.profile, directory);

    if (signal.aborted) {
      throw new ToolError("Interrupted");
    }

    firefox = startFirefox(options.firefox, directory, signal, options.headed);
    bidi = await Bidi.open(await firefox.endpoint, signal);

    return await drivePage(
      bidi,
      authorizeUrl,
      options.inspect,
      options.timeoutMs,
      signal,
      options.account,
    );
  } finally {
    bidi?.close();

    if (firefox !== undefined) {
      await stopFirefox(firefox.process);
    }

    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const controller = new AbortController();

  const interrupt = (): void => {
    controller.abort();
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    if (options.inspect) {
      await browserCallback(inspectionUrl(), options, controller.signal);

      return;
    }

    await connect(options, controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof ToolError ? error.message : "ChatGPT connection failed");
  process.exitCode = 1;
}

async function connect(
  options: ReturnType<typeof parseOptions>,
  signal: AbortSignal,
): Promise<void> {
  const headers = await serviceHeaders(options);
  const login = await post(options, headers, "/api/chatgpt/login", {}, signal);
  const attemptId = login.text("chatgpt.login.attemptId");
  const authorizeUrl = login.text("chatgpt.login.authorizeUrl");

  if (
    attemptId === undefined ||
    attemptId === "" ||
    authorizeUrl === undefined ||
    authorizeUrl === "" ||
    new URL(authorizeUrl).origin !== "https://auth.openai.com"
  ) {
    throw new ToolError("Owner API returned an invalid login");
  }

  const callbackUrl = await browserCallback(authorizeUrl, options, signal);
  const callback = new URL(callbackUrl);

  if (callback.searchParams.has("error")) {
    throw new ToolError("ChatGPT callback contains error");
  }

  const completed = await post(
    options,
    headers,
    "/api/chatgpt/login/complete",
    { attemptId, callbackUrl },
    signal,
  );

  const expiresAt = completed.count("chatgpt.connection.expiresAt");

  if (
    completed.value("ok") !== true ||
    completed.text("chatgpt.connection.state") !== "connected" ||
    expiresAt === undefined ||
    !Number.isFinite(expiresAt)
  ) {
    throw new ToolError("Owner API returned an invalid completion");
  }

  console.log(`ChatGPT connected; access token expires at ${new Date(expiresAt).toISOString()}`);
}
